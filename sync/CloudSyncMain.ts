import { CloudSyncSettings, LogLevel, AzureSettings, AWSSettings, GCPSettings } from "./types";
import { CloudSyncError, AuthenticationError, ConnectivityError, ConfigurationError, SyncError } from "./errors";
import { LocalManager } from "./localManager";
import { AbstractManager } from "./AbstractManager";
import { LogManager } from "../LogManager";
import { AzureManager } from "../Azure/AzureManager";
import { AWSManager } from "../AWS/AWSManager";
import { GCPManager } from "../GCP/GCPManager";
import { Synchronize } from "./Synchronize";
import { App, Notice, normalizePath } from "obsidian";
import { CacheManager } from "./CacheManager";

export class CloudSyncMain {
    public localVault: LocalManager | null = null;
    public remoteVaults: AbstractManager[] = [];
    private app: App;
    private settings: CloudSyncSettings;
    private statusBar: HTMLElement;
    private syncIcon: Element | null = null;

    constructor(
        app: App,
        settings: CloudSyncSettings,
        statusBar: HTMLElement
    ) {
        this.app = app;
        this.settings = settings;
        this.statusBar = statusBar;

        LogManager.log(LogLevel.Debug, 'CloudSync plugin initialized', {
            settings: {
                azureEnabled: settings.azureEnabled,
                awsEnabled: settings.awsEnabled,
                gcpEnabled: settings.gcpEnabled,
                autoSyncDelay: settings.autoSyncDelay
            }
        });
    }

    setSyncIcon(icon: Element | null) {
        this.syncIcon = icon;
        if (!this.syncIcon) {
            LogManager.log(LogLevel.Debug, 'No sync icon provided');
            return;
        }
        this.syncIcon.classList.remove('cloud-sync-spin', 'cloud-sync-error');
        this.syncIcon.classList.add('cloud-sync-spin');
        LogManager.log(LogLevel.Debug, 'Sync icon activated');
    }

    private setErrorIcon() {
        if (this.syncIcon) {
            this.syncIcon.classList.remove('cloud-sync-spin');
            this.syncIcon.classList.add('cloud-sync-error');
            LogManager.log(LogLevel.Debug, 'Error icon activated');
        }
    }

    private showError(error: Error | string) {
        const message = error instanceof Error ? error.message : error;
        new Notice(message, 30000);
        LogManager.log(LogLevel.Error, message);
        this.setErrorIcon();
    }

    private validateProviderSettings(provider: 'azure' | 'aws' | 'gcp'): void {
        switch (provider) {
            case 'azure': {
                const settings = this.settings.azure as AzureSettings;
                if (!settings.account || !settings.accessKey) {
                    throw new ConfigurationError('Azure', 'Missing required settings: account and accessKey');
                }
                break;
            }
            case 'aws': {
                const settings = this.settings.aws as AWSSettings;
                if (!settings.accessKey || !settings.secretKey || !settings.bucket) {
                    throw new ConfigurationError('AWS', 'Missing required settings: accessKey, secretKey, and bucket');
                }
                break;
            }
            case 'gcp': {
                const settings = this.settings.gcp as GCPSettings;
                if (!settings.privateKey || !settings.clientEmail || !settings.bucket) {
                    throw new ConfigurationError('GCP', 'Missing required settings: privateKey, clientEmail, and bucket');
                }
                break;
            }
        }
    }

    async runCloudSync(): Promise<void> {
        LogManager.log(LogLevel.Trace, 'Starting cloud synchronization');

        try {
            LogManager.log(LogLevel.Debug, 'Initializing local vault');
            const tempCachePath = normalizePath(`${this.app.vault.configDir}/plugins/cloudsync/cloudsync-temp.json`);
            const tempCache = CacheManager.getInstance(tempCachePath, this.app);
            await tempCache.readCache();

            this.localVault = new LocalManager(this.settings, this.app, tempCache);
            if (!this.localVault) {
                throw new ConfigurationError('Local vault', 'Failed to initialize');
            }

            const localConnectivity = await this.localVault.testConnectivity();
            if (!localConnectivity.success) {
                throw new ConnectivityError('local vault', localConnectivity.message);
            }
            LogManager.log(LogLevel.Debug, 'Local vault connectivity verified');

            const vaultName = this.localVault.getVaultName();
            LogManager.log(LogLevel.Debug, `Processing vault: ${vaultName}`);

            if (this.settings.azureEnabled) {
                try {
                    this.validateProviderSettings('azure');
                    LogManager.addDelimiter();
                    LogManager.log(LogLevel.Trace, 'Azure sync starting');
                    const azureVault = new AzureManager(this.settings, vaultName);
                    await azureVault.authenticate().catch(error => {
                        throw new AuthenticationError('Azure', error.message);
                    });
                    const sync = new Synchronize(this.localVault, azureVault, normalizePath(`${this.app.vault.configDir}/plugins/cloudsync/cloudsync-${azureVault.name.toLowerCase()}.json`));
                    const scenarios = await sync.syncActions();
                    await sync.runAllScenarios(scenarios);
                } catch (error) {
                    if (error instanceof CloudSyncError) throw error;
                    throw new SyncError('Azure sync', error.message);
                }
            }

            if (this.settings.awsEnabled) {
                try {
                    this.validateProviderSettings('aws');
                    LogManager.addDelimiter();
                    LogManager.log(LogLevel.Trace, 'AWS sync starting');
                    const awsVault = new AWSManager(this.settings, vaultName);
                    await awsVault.authenticate().catch(error => {
                        throw new AuthenticationError('AWS', error.message);
                    });
                    const sync = new Synchronize(this.localVault, awsVault, normalizePath(`${this.app.vault.configDir}/plugins/cloudsync/cloudsync-${awsVault.name.toLowerCase()}.json`));
                    const scenarios = await sync.syncActions();
                    await sync.runAllScenarios(scenarios);
                } catch (error) {
                    if (error instanceof CloudSyncError) throw error;
                    throw new SyncError('AWS sync', error.message);
                }
            }

            if (this.settings.gcpEnabled) {
                try {
                    this.validateProviderSettings('gcp');
                    LogManager.addDelimiter();
                    LogManager.log(LogLevel.Trace, 'GCP sync starting');
                    const gcpVault = new GCPManager(this.settings, vaultName);
                    await gcpVault.authenticate().catch(error => {
                        throw new AuthenticationError('GCP', error.message);
                    });
                    const sync = new Synchronize(this.localVault, gcpVault, normalizePath(`${this.app.vault.configDir}/plugins/cloudsync/cloudsync-${gcpVault.name.toLowerCase()}.json`));
                    const scenarios = await sync.syncActions();
                    await sync.runAllScenarios(scenarios);
                } catch (error) {
                    if (error instanceof CloudSyncError) throw error;
                    throw new SyncError('GCP sync', error.message);
                }
            }

            LogManager.log(LogLevel.Trace, 'Cloud synchronization completed', undefined, false, false);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.showError(errorMessage);
            throw error;
        } finally {
            if (this.syncIcon) {
                this.syncIcon.classList.remove('cloud-sync-spin');
                LogManager.log(LogLevel.Debug, 'Sync icon deactivated');
            }
        }
    }
}
