import { AbstractManager, File } from "../sync/AbstractManager";
import { CloudSyncSettings, LogLevel } from "../sync/types";
import { LogManager } from "../LogManager";
import { AWSAuth } from "./auth";
import { AWSSigning } from "./signing";
import { AWSFiles } from "./files";
import { AWSPathHandler } from "./AWSPathHandler";
import { App } from "obsidian";

export class AWSManager extends AbstractManager {
    public readonly name: string = 'S3';

    private bucket = '';
    private accessKey = '';
    private secretKey = '';
    private endpoint = '';
    private auth: AWSAuth;
    private signing: AWSSigning;
    private fileOps: AWSFiles;
    private readonly paths: AWSPathHandler;
    private readonly vaultPrefix: string;

    constructor(settings: CloudSyncSettings, vaultPrefix: string) {
        super(settings);
        this.vaultPrefix = vaultPrefix;
        this.paths = new AWSPathHandler(this.vaultPrefix);
        LogManager.log(LogLevel.Debug, 'S3 manager initialized', {
            vault: this.vaultPrefix
        });
    }

    private validateSettings(): void {
        LogManager.log(LogLevel.Debug, 'Validating S3 configuration');
        if (!this.settings.aws.accessKey || this.settings.aws.accessKey.trim() === '') {
            throw new Error('S3 access key is required');
        }
        if (!this.settings.aws.secretKey || this.settings.aws.secretKey.trim() === '') {
            throw new Error('S3 secret key is required');
        }
        if (!this.settings.aws.bucket || this.settings.aws.bucket.trim() === '') {
            throw new Error('S3 bucket name is required');
        }
        LogManager.log(LogLevel.Debug, 'S3 configuration validated');
    }

    private async initializeClient(skipEndpointDiscovery = false): Promise<void> {
        LogManager.log(LogLevel.Debug, 'Initializing S3 client');

        this.bucket = this.settings.aws.bucket.trim();
        this.accessKey = this.settings.aws.accessKey.trim();
        this.secretKey = this.settings.aws.secretKey.trim();

        const app = (this.settings as any).app as App;
        if (!app) {
            throw new Error('App instance not available in settings');
        }

        if (!skipEndpointDiscovery && !this.settings.aws.endpoint) {
            LogManager.log(LogLevel.Debug, 'Discovering bucket endpoint');
            const region = await this.discoverRegion();
            this.endpoint = `https://s3.${region}.amazonaws.com`;

            // Store the discovered endpoint in settings
            this.settings.aws.endpoint = this.endpoint;
            if (this.settings.saveSettings) {
                await this.settings.saveSettings();
                LogManager.log(LogLevel.Debug, `Endpoint saved to settings: ${this.endpoint}`);
            }
        } else {
            this.endpoint = this.settings.aws.endpoint;
        }

        // Extract region from endpoint for signing
        const regionMatch = /s3[.-]([^.]+)\.amazonaws\.com/.exec(this.endpoint);
        const region = regionMatch ? regionMatch[1] : 'us-east-1';
        this.signing = new AWSSigning(this.accessKey, this.secretKey, region);
        this.auth = new AWSAuth(this.bucket, this.endpoint, this.signing, this.vaultPrefix, app);

        const cachePath = `${app.vault.configDir}/plugins/cloudsync`;
        try {
            await app.vault.adapter.mkdir(cachePath);
            LogManager.log(LogLevel.Debug, 'Cache directory created');
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('EEXIST')) {
                throw error;
            }
            LogManager.log(LogLevel.Debug, 'Cache directory already exists');
        }

        this.fileOps = new AWSFiles(this.bucket, this.endpoint, this.signing, this.paths, {
            ...this.settings,
            app
        });

        LogManager.log(LogLevel.Debug, 'S3 client configuration', {
            bucket: this.bucket,
            endpoint: this.endpoint
        });
    }

    async authenticate(): Promise<void> {
        try {
            LogManager.log(LogLevel.Trace, 'Authenticating with S3');
            this.validateSettings();
            await this.initializeClient();

            const result = await this.auth.testConnectivity();
            if (!result.success) {
                throw new Error(result.message);
            }

            LogManager.log(LogLevel.Trace, 'S3 authentication successful');
        } catch (error) {
            LogManager.log(LogLevel.Error, 'S3 authentication failed', error);
            throw error;
        }
    }

    async testConnectivity(): Promise<{ success: boolean; message: string; details?: unknown }> {
        try {
            LogManager.log(LogLevel.Trace, 'Testing S3 connectivity');
            this.validateSettings();
            await this.initializeClient();

            const result = await this.auth.testConnectivity();
            if (result.success) {
                LogManager.log(LogLevel.Debug, 'S3 connectivity test successful');
            } else {
                LogManager.log(LogLevel.Debug, 'S3 connectivity test failed', result);
            }
            return result;
        } catch (error) {
            LogManager.log(LogLevel.Error, 'S3 connectivity test failed', error);
            return {
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
                details: error
            };
        }
    }

    private async discoverRegion(): Promise<string> {
        try {
            LogManager.log(LogLevel.Trace, 'Discovering bucket region');
            this.validateSettings();

            // Initialize temporary client with default region
            const tempEndpoint = 'https://s3.us-east-1.amazonaws.com';
            const tempSigning = new AWSSigning(this.accessKey, this.secretKey, 'us-east-1');
            const app = (this.settings as any).app as App;
            const tempAuth = new AWSAuth(this.bucket, tempEndpoint, tempSigning, this.vaultPrefix, app);

            const region = await tempAuth.discoverRegion();
            LogManager.log(LogLevel.Debug, `Bucket region discovered: ${region}`);
            return region;
        } catch (error) {
            LogManager.log(LogLevel.Error, 'Failed to discover bucket region', error);
            throw error;
        }
    }

    readFile(file: File): Promise<Uint8Array> {
        LogManager.log(LogLevel.Debug, `Reading file from S3: ${file.name}`);
        return this.fileOps.readFile(file);
    }

    async writeFile(file: File, content: Uint8Array): Promise<void> {
        LogManager.log(LogLevel.Debug, `Writing file to S3: ${file.name} (${content.length} bytes)`);
        await this.fileOps.writeFile(file, content);
    }

    async deleteFile(file: File): Promise<void> {
        LogManager.log(LogLevel.Debug, `Deleting file from S3: ${file.name}`);
        await this.fileOps.deleteFile(file);
    }

    async getFiles(): Promise<File[]> {
        LogManager.log(LogLevel.Trace, 'Listing files in S3 bucket');
        const files = await this.fileOps.getFiles();
        this.files = files;
        LogManager.log(LogLevel.Debug, `Found ${files.length} files in S3 bucket`);
        return files;
    }
}
