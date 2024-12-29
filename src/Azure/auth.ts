import { LogManager } from "../LogManager";
import { LogLevel } from "../sync/types";
import { AzurePaths } from "./paths";
import * as CryptoJS from 'crypto-js';
import { CacheManagerService } from "../sync/utils/cacheUtils";
import { App, normalizePath } from "obsidian";

export class AzureAuth {
    private sasToken = '';

    constructor(
        private readonly account: string,
        private readonly accessKey: string,
        private readonly paths: AzurePaths,
        private readonly app: App
    ) {}

    validateSettings(): void {
        LogManager.log(LogLevel.Debug, 'Validating Azure configuration');

        const maskedKey = this.accessKey
            ? `${this.accessKey.substring(0, 4)}...${this.accessKey.substring(this.accessKey.length - 4)}`
            : 'not set';

        LogManager.log(LogLevel.Debug, 'Azure credentials', {
            account: this.account || 'not set',
            accessKey: maskedKey
        });

        if (!this.account || this.account.trim() === '') {
            throw new Error('Azure Storage account name is required');
        }
        if (!this.accessKey || this.accessKey.trim() === '') {
            throw new Error('Azure Storage access key is required');
        }

        LogManager.log(LogLevel.Debug, 'Azure configuration validated');
    }

    private createSignature(stringToSign: string): string {
        const keyBytes = CryptoJS.enc.Base64.parse(this.accessKey);
        const hmac = CryptoJS.HmacSHA256(stringToSign, keyBytes);
        return CryptoJS.enc.Base64.stringify(hmac);
    }

    generateSasToken(): string {
        LogManager.log(LogLevel.Debug, 'Generating Azure SAS token');

        try {
            const startsOn = new Date();
            const expiresOn = new Date(startsOn);
            expiresOn.setHours(startsOn.getHours() + 1);

            const permissions = 'rwdlac';
            const services = 'b';
            const resourceTypes = 'sco';

            const formatDate = (date: Date) => date.toISOString().slice(0, 19) + 'Z';
            const start = formatDate(startsOn);
            const expiry = formatDate(expiresOn);

            const stringToSign = [
                this.account,
                permissions,
                services,
                resourceTypes,
                start,
                expiry,
                '',
                'https',
                '2020-04-08',
                ''
            ].join('\n');

            const signature = this.createSignature(stringToSign);

            const sasParams = new URLSearchParams({
                'sv': '2020-04-08',
                'ss': services,
                'srt': resourceTypes,
                'sp': permissions,
                'se': expiry,
                'st': start,
                'spr': 'https',
                'sig': signature
            });

            this.sasToken = sasParams.toString();
            LogManager.log(LogLevel.Debug, 'Azure SAS token generated');
            return this.sasToken;
        } catch (error) {
            LogManager.log(LogLevel.Error, 'Failed to generate SAS token', error);
            throw new Error(`Failed to generate SAS token: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    getSasToken(): string {
        return this.sasToken || this.generateSasToken();
    }

    async ensureContainer(): Promise<void> {
        LogManager.log(LogLevel.Debug, 'Verifying Azure container exists');
        try {
            const listUrl = this.paths.getContainerUrl(this.account, this.getSasToken(), 'list');
            LogManager.log(LogLevel.Debug, 'Checking container with URL', { url: listUrl });

            const response = await fetch(listUrl);
            LogManager.log(LogLevel.Debug, 'Container check response', { status: response.status });

            if (response.status === 404) {
                LogManager.log(LogLevel.Debug, 'Container not found, creating new container');
                const createUrl = this.paths.getContainerUrl(this.account, this.getSasToken());
                LogManager.log(LogLevel.Debug, 'Creating container with URL', { url: createUrl });

                const createResponse = await fetch(createUrl, {
                    method: 'PUT',
                    headers: {
                        'x-ms-version': '2020-04-08'
                    }
                });

                if (createResponse.status === 201) {
                    LogManager.log(LogLevel.Debug, 'Azure container created successfully');

                    // Invalidate both Azure and sync caches after container creation
                    const cacheService = CacheManagerService.getInstance();
                    const azureCachePath = normalizePath(`${this.app.vault.configDir}/plugins/cloudsync/cloudsync-azure.json`);
                    const syncCachePath = normalizePath(`${this.app.vault.configDir}/plugins/cloudsync/cloudsync-temp.json`);
                    await Promise.all([
                        cacheService.invalidateCache(azureCachePath),
                        cacheService.invalidateCache(syncCachePath)
                    ]);
                    LogManager.log(LogLevel.Debug, 'Azure and sync caches invalidated after container creation');

                    // Throw special error to indicate new container
                    throw new Error('NEW_CONTAINER');
                } else if (createResponse.status === 403) {
                    throw new Error(
                        'Permission denied when creating container. Please ensure:\n' +
                        '1. Your SAS token is correct\n' +
                        '2. CORS is enabled on your Azure Storage account'
                    );
                } else {
                    const text = await createResponse.text();
                    throw new Error(`Failed to create container. Status: ${createResponse.status}, Response: ${text}`);
                }
            } else if (response.status === 409) {
                const text = await response.text();
                if (text.includes('PublicAccessNotPermitted')) {
                    throw new Error(
                        'Public access is not permitted on this storage account. Please ensure your SAS token has the correct permissions.'
                    );
                } else {
                    throw new Error(`Unexpected response when checking container. Status: ${response.status}, Response: ${text}`);
                }
            } else if (response.status !== 200) {
                const text = await response.text();
                throw new Error(`Unexpected response when checking container. Status: ${response.status}, Response: ${text}`);
            }

            LogManager.log(LogLevel.Trace, 'Azure container verified');
        } catch (error) {
            if (error instanceof TypeError && error.message === 'Failed to fetch') {
                throw new Error(
                    'Unable to connect to Azure Storage. Please check:\n' +
                    '1. Your internet connection\n' +
                    '2. CORS is enabled on your Azure Storage account'
                );
            }
            throw error;
        }
    }

    async testConnectivity(): Promise<{ success: boolean; message: string; details?: any }> {
        try {
            LogManager.log(LogLevel.Debug, 'Testing Azure connectivity');
            this.validateSettings();

            const url = this.paths.getContainerUrl(this.account, this.getSasToken(), 'list');
            LogManager.log(LogLevel.Debug, 'Testing connectivity with URL', { url });

            const response = await fetch(url);
            LogManager.log(LogLevel.Debug, 'Connectivity test response', { status: response.status });

            if (response.status === 200) {
                LogManager.log(LogLevel.Trace, 'Azure connectivity test successful');
                return {
                    success: true,
                    message: "Successfully connected to Azure Storage"
                };
            } else if (response.status === 404) {
                LogManager.log(LogLevel.Debug, 'Azure container not found (will be created during sync)');
                return {
                    success: true,
                    message: "Connected to Azure Storage (container will be created during sync)"
                };
            }

            const text = await response.text();
            throw response.status === 403
                ? new Error(
                    'Permission denied. Please verify:\n' +
                    '1. Your SAS token is correct\n' +
                    '2. CORS is enabled on your Azure Storage account'
                )
                : new Error(`HTTP status: ${response.status}, Response: ${text}`);
        } catch (error) {
            LogManager.log(LogLevel.Error, 'Azure connectivity test failed', error);
            return {
                success: false,
                message: `Azure connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                details: error
            };
        }
    }
}