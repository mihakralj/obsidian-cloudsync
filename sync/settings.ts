import { App, Notice, PluginSettingTab, Setting, normalizePath } from "obsidian";
import CloudSyncPlugin from "../main";
import { AWSManager } from "../AWS/AWSManager";
import { AzureManager } from "../Azure/AzureManager";
import { GCPManager } from "../GCP/GCPManager";
import { LogLevel } from "./types";
import { LogManager } from "../LogManager";
import { LocalManager } from "./localManager";
import { CacheManager } from "./CacheManager";

export class CloudSyncSettingTab extends PluginSettingTab {
    plugin: CloudSyncPlugin;

    constructor(app: App, plugin: CloudSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private getProviderManager(name: string) {
        switch (name) {
            case 'aws':
                return AWSManager;
            case 'azure':
                return AzureManager;
            case 'gcp':
                return GCPManager;
            default:
                throw new Error(`Unknown provider: ${name}`);
        }
    }

    private async createLocalManager(): Promise<LocalManager> {
        const pluginDir = this.plugin.manifest.dir;
        if (!pluginDir) {
            throw new Error('Plugin directory not found');
        }
        const tempCachePath = normalizePath(`${pluginDir}/cloudsync-temp.json`);
        const tempCache = CacheManager.getInstance(tempCachePath, this.app);
        await tempCache.readCache();
        return new LocalManager(this.plugin.settings, this.app, tempCache);
    }

    private async clearCache(provider: string) {
        try {
            const localManager = await this.createLocalManager();
            const pluginDir = this.plugin.manifest.dir;
            if (!pluginDir) {
                throw new Error('Plugin directory not found');
            }
            const cacheFile = normalizePath(`${pluginDir}/cloudsync-${provider}.json`);
            if (await this.app.vault.adapter.exists(cacheFile)) {
                await this.app.vault.adapter.remove(cacheFile);
                LogManager.log(LogLevel.Info, `Cache cleared for ${provider}`, undefined, true, false);
                new Notice(`Cache cleared for ${provider}`);
            } else {
                LogManager.log(LogLevel.Info, `No cache file found for ${provider}`, undefined, true, false);
                new Notice(`No cache file found for ${provider}`);
            }
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to clear cache for ${provider}`, error);
            new Notice(`Failed to clear cache for ${provider}: ${error.message}`);
        }
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('Auto-Sync Delay')
            .setDesc('How long to wait after changes before auto-syncing')
            .addDropdown(dropdown => dropdown
                .addOptions({
                    '0': 'Disabled',
                    '10': '10 seconds',
                    '30': '30 seconds',
                    '60': '60 seconds',
                    '180' : '3 minutes'
                })
                .setValue(this.plugin.settings.autoSyncDelay.toString())
                .onChange(async (value) => {
                    this.plugin.settings.autoSyncDelay = parseInt(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Logging Level')
            .setDesc('Set the level of logging detail')
            .addDropdown(dropdown => dropdown
                .addOptions({
                    [LogLevel.None]: 'None',
                    [LogLevel.Info]: 'Info',
                    [LogLevel.Trace]: 'Trace',
                    [LogLevel.Debug]: 'Debug'
                })
                .setValue(this.plugin.settings.logLevel)
                .onChange(async (value: LogLevel) => {
                    await this.plugin.handleLogLevelChange(value);
                    await this.plugin.saveSettings();
                }));

        const azureSetting = new Setting(containerEl)
            .setName('Enable Azure Storage')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.azureEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.azureEnabled = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        const azureDescEl = azureSetting.descEl;
        const azureSetupLink = azureDescEl.createEl('a', {
            text: 'Setup guide',
            href: 'https://github.com/mihakralj/obsidian-cloudsync/blob/main/doc/azure.md'
        });
        azureSetupLink.setAttr('target', '_blank');

        if (this.plugin.settings.azureEnabled) {
            new Setting(containerEl)
                .setName('Access Key')
                .setDesc(`key1 or key2 available in Azure portal under Storage - Security - Access keys`)
                .addText(text => text
                    .setPlaceholder('Enter access key')
                    .setValue(this.plugin.settings.azure.accessKey ?? '')
                    .onChange(async (value) => {
                        this.plugin.settings.azure.accessKey = value;
                        await this.plugin.saveSettings();
                    }));
            new Setting(containerEl)
                .setName('Storage Account Name')
                .setDesc('globally unique name available in Azure portal under Storage Accounts')
                .addText(text => text
                    .setPlaceholder('Enter storage account name')
                    .setValue(this.plugin.settings.azure.account ?? '')
                    .onChange(async (value) => {
                        this.plugin.settings.azure.account = value;
                        await this.plugin.saveSettings();
                    }));
            new Setting(containerEl)
                .addButton(button => button
                    .setButtonText('Test Azure Connection')
                    .onClick(async () => {
                        try {
                            const localManager = await this.createLocalManager();
                            const vaultName = localManager.getVaultName();
                            const Manager = this.getProviderManager('azure');
                            const manager = new Manager(this.plugin.settings, vaultName);
                            const result = await manager.testConnectivity();
                            if (result.success) {
                                LogManager.log(LogLevel.Info, 'Azure connection test successful');
                                new Notice('Azure connection successful!');
                            } else {
                                LogManager.log(LogLevel.Error, 'Azure connection test failed', result);
                                new Notice(`Azure connection failed: ${result.message}`);
                            }
                        } catch (error) {
                            LogManager.log(LogLevel.Error, 'Azure connection test error', error);
                            new Notice(`Azure connection failed: ${error.message}`);
                        }
                    }))
                .addButton(button => button
                    .setButtonText('Clear  Azure Cache')
                    .onClick(() => this.clearCache('azure')));
        }

        const awsSetting = new Setting(containerEl)
            .setName('Enable AWS S3')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.awsEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.awsEnabled = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        const awsDescEl = awsSetting.descEl;
        const awsSetupLink = awsDescEl.createEl('a', {
            text: 'Setup guide',
            href: 'https://github.com/mihakralj/obsidian-cloudsync/blob/main/doc/aws.md'
        });
        awsSetupLink.setAttr('target', '_blank');

        if (this.plugin.settings.awsEnabled) {
            new Setting(containerEl)
                .setName('Access Key')
                .setDesc('Acces key 1 or Access key 2 under IAM - Users - Account name')
                .addText(text => text
                    .setPlaceholder('Enter access key')
                    .setValue(this.plugin.settings.aws.accessKey ?? '')
                    .onChange(async (value) => {
                        this.plugin.settings.aws.accessKey = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Secret Key')
                .setDesc('Retreived at the time of Access key creation - cannot be retreived later')
                .addText(text => text
                    .setPlaceholder('Enter secret key')
                    .setValue(this.plugin.settings.aws.secretKey ?? '')
                    .onChange(async (value) => {
                        this.plugin.settings.aws.secretKey = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('S3 Bucket Name')
                .setDesc('Globally unique bucket name available in AWS portal under S3 Storage')
                .addText(text => text
                    .setPlaceholder('Enter bucket name')
                    .setValue(this.plugin.settings.aws.bucket ?? '')
                    .onChange(async (value) => {
                        this.plugin.settings.aws.bucket = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .addButton(button => button
                    .setButtonText('Test AWS Connection')
                    .onClick(async () => {
                        try {
                            const localManager = await this.createLocalManager();
                            const vaultName = localManager.getVaultName();
                            const Manager = this.getProviderManager('aws');
                            const manager = new Manager(this.plugin.settings, vaultName) as AWSManager;

                            const region = await manager.discoverRegion();
                            this.plugin.settings.aws.region = region;
                            await this.plugin.saveSettings();
                            LogManager.log(LogLevel.Debug, 'Discovered and saved region', { region });

                            const result = await manager.testConnectivity();
                            if (result.success) {
                                LogManager.log(LogLevel.Info, 'AWS connection test successful');
                                new Notice('AWS connection successful!');
                            } else {
                                LogManager.log(LogLevel.Error, 'AWS connection test failed', result);
                                new Notice(`AWS connection failed: ${result.message}`);
                            }
                        } catch (error) {
                            LogManager.log(LogLevel.Error, 'AWS connection test error', error);
                            new Notice(`AWS connection failed: ${error.message}`);
                        }
                    }))
                .addButton(button => button
                    .setButtonText('Clear AWS Cache')
                    .onClick(() => this.clearCache('aws')));
        }

        const gcpSetting = new Setting(containerEl)
            .setName('Enable Google Cloud Storage')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.gcpEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.gcpEnabled = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        const gcpDescEl = gcpSetting.descEl;
        const gcpSetupLink = gcpDescEl.createEl('a', {
            text: 'Setup guide',
            href: 'https://github.com/mihakralj/obsidian-cloudsync/blob/main/doc/gcp.md'
        });
        gcpSetupLink.setAttr('target', '_blank');

        if (this.plugin.settings.gcpEnabled) {
            new Setting(containerEl)
                .setName('Private Key')
                .setDesc('Retreived from .json file with keys and credentials')
                .addTextArea(text => text
                    .setPlaceholder('Enter private key JSON')
                    .setValue(this.plugin.settings.gcp.privateKey ?? '')
                    .onChange(async (value) => {
                        this.plugin.settings.gcp.privateKey = value;
                        await this.plugin.saveSettings();
                    })
                    .inputEl.rows = 4);

            new Setting(containerEl)
                .setName('Client Email')
                .setDesc('Retreived from .json file with keys and credentials')
                .addText(text => text
                    .setPlaceholder('Enter client email')
                    .setValue(this.plugin.settings.gcp.clientEmail ?? '')
                    .onChange(async (value) => {
                        this.plugin.settings.gcp.clientEmail = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Storage Bucket Name')
                .setDesc('Retreived from GCP Cloud Storage console')
                .addText(text => text
                    .setPlaceholder('Enter bucket name')
                    .setValue(this.plugin.settings.gcp.bucket ?? '')
                    .onChange(async (value) => {
                        this.plugin.settings.gcp.bucket = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .addButton(button => button
                    .setButtonText('Test GCP Connection')
                    .onClick(async () => {
                        try {
                            const localManager = await this.createLocalManager();
                            const vaultName = localManager.getVaultName();
                            const Manager = this.getProviderManager('gcp');
                            const manager = new Manager(this.plugin.settings, vaultName);
                            const result = await manager.testConnectivity();
                            if (result.success) {
                                LogManager.log(LogLevel.Info, 'GCP connection test successful');
                                new Notice('GCP connection successful!');
                            } else {
                                LogManager.log(LogLevel.Error, 'GCP connection test failed', result);
                                new Notice(`GCP connection failed: ${result.message}`);
                            }
                        } catch (error) {
                            LogManager.log(LogLevel.Error, 'GCP connection test error', error);
                            new Notice(`GCP connection failed: ${error.message}`);
                        }
                    }))
                .addButton(button => button
                    .setButtonText('Clear GCP Cache')
                    .onClick(() => this.clearCache('gcp')));
        }

        new Setting(containerEl)
            .setName('Sync Ignore List')
            .setDesc('List of files/folders to ignore during sync (one per line)')
            .addTextArea(text => text
                .setPlaceholder('Enter paths to ignore')
                .setValue(this.plugin.settings.syncIgnore)
                .onChange(async (value) => {
                    this.plugin.settings.syncIgnore = value;
                    await this.plugin.saveSettings();
                }));
    }
}
