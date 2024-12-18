import { Plugin, Notice, WorkspaceLeaf, TAbstractFile } from "obsidian";
import { CloudSyncSettings, DEFAULT_SETTINGS, LogLevel } from "./sync/types";
import { CloudSyncSettingTab } from "./sync/settings";
import { LogView, LOG_VIEW_TYPE } from "./LogView";
import { CloudSyncMain } from "./sync/CloudSyncMain";
import { LogManager } from "./LogManager";
import { Container, cleanupContainer, registerCleanup } from "./sync/utils/container";
import { ResourceManager } from "./sync/utils/timeoutUtils";

type LogType = 'info' | 'error' | 'trace' | 'success' | 'debug' | 'delimiter';

@registerCleanup
export default class CloudSyncPlugin extends Plugin {
    settings: CloudSyncSettings;
    statusBar: HTMLElement | undefined;
    cloudSync: CloudSyncMain;
    private pendingLogs: Array<{message: string, type: LogType, update: boolean}> = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private ribbonIconEl: HTMLElement | null = null;
    private encoder = new TextEncoder();
    private decoder = new TextDecoder();
    private container: Container;

    private obfuscate(str: string): string {
        if (!str) return str;
        return btoa(str);
    }

    private deobfuscate(str: string): string {
        if (!str) return str;
        try {
            return atob(str);
        } catch {
            return str;
        }
    }

    private async executeSync() {
        const anyCloudEnabled = this.settings.azureEnabled ||
                              this.settings.awsEnabled ||
                              this.settings.gcpEnabled;

        if (!anyCloudEnabled) {
            LogManager.log(LogLevel.Info, 'No cloud services are enabled. Please enable at least one service in settings.');
            new Notice('CloudSync: Please enable at least one cloud service in settings');
            return;
        }

        if (this.settings.logLevel !== LogLevel.None) {
            await this.ensureLogViewExists();
        }

        const svgIcon = this.ribbonIconEl?.querySelector('.svg-icon');
        if (svgIcon) {
            this.cloudSync.setSyncIcon(svgIcon);
        }
        await this.cloudSync.runCloudSync();
    }

    private handleVaultChange = (file: TAbstractFile) => {
        if (this.timer) {
            ResourceManager.clearTimer(this.timer);
            this.timer = null;
        }

        if (this.settings.autoSyncDelay > 0) {
            LogManager.log(LogLevel.Trace, `Starting auto-sync countdown for ${this.settings.autoSyncDelay} seconds`);
            LogManager.log(LogLevel.Debug, `File ${file.path} was changed`);

            this.timer = setTimeout(async () => {
                LogManager.log(LogLevel.Trace, `Auto-sync timer triggered after ${this.settings.autoSyncDelay} seconds of inactivity`);
                await this.executeSync();
            }, this.settings.autoSyncDelay * 1000);

            ResourceManager.registerTimer(this.timer);
        } else {
            LogManager.log(LogLevel.Trace, 'Auto-sync is disabled (delay set to 0)');
        }
    };

    async onload() {
        // Initialize container
        this.container = Container.getInstance(this.app);

        this.registerView(
            LOG_VIEW_TYPE,
            (leaf: WorkspaceLeaf) => {
                const view = new LogView(leaf, this);
                this.processPendingLogs();
                return view;
            }
        );

        LogManager.setLogFunction((message: string, type?: LogType, update?: boolean, important?: boolean) => {
            this.baseLog(message, type, update, important);
        });

        await this.loadSettings();

        // Register vault event listeners for file changes
        this.registerEvent(this.app.vault.on('create', this.handleVaultChange));
        this.registerEvent(this.app.vault.on('modify', this.handleVaultChange));
        this.registerEvent(this.app.vault.on('delete', this.handleVaultChange));
        this.registerEvent(this.app.vault.on('rename', this.handleVaultChange));

        if (this.settings.logLevel !== LogLevel.None) {
            setTimeout(() => this.activateLogView(), 500);
        }

        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.processPendingLogs();
            })
        );

        const anyCloudEnabled = this.settings.azureEnabled ||
                              this.settings.awsEnabled ||
                              this.settings.gcpEnabled;

        this.statusBar = this.addStatusBarItem();

        this.cloudSync = new CloudSyncMain(
            this.app,
            this.settings,
            this.statusBar
        );

        LogManager.log(LogLevel.Debug, 'Plugin initialization', {
            enabledServices: {
                azure: this.settings.azureEnabled,
                aws: this.settings.awsEnabled,
                gcp: this.settings.gcpEnabled
            },
            logLevel: this.settings.logLevel,
            autoSyncDelay: this.settings.autoSyncDelay
        });

        this.ribbonIconEl = this.addRibbonIcon(
            'refresh-cw',
            'CloudSync',
            async () => {
                await this.executeSync();
            }
        );

        this.addSettingTab(new CloudSyncSettingTab(this.app, this));

        if (!anyCloudEnabled) {
            LogManager.log(LogLevel.Info, 'Please configure cloud services in settings');
            new Notice('CloudSync: Please configure cloud services in settings');
        }

        const initialSyncTimer = setTimeout(async () => {
            await this.executeSync();
        }, 1000);
        ResourceManager.registerTimer(initialSyncTimer);
    }

    private getLogView(): LogView | null {
        const leaves = this.app.workspace.getLeavesOfType(LOG_VIEW_TYPE);
        if (leaves.length > 0) {
            const view = leaves[0].view;
            if (view instanceof LogView) {
                return view;
            }
        }
        return null;
    }

    private async ensureLogViewExists() {
        if (this.settings.logLevel !== LogLevel.None && !this.getLogView()) {
            await this.activateLogView();
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    private processPendingLogs() {
        if (this.pendingLogs.length === 0) return;

        const logView = this.getLogView();
        if (!logView) return;

        for (const log of this.pendingLogs) {
            try {
                logView.addLogEntry(log.message, log.type, log.update);
            } catch (error) {
                console.debug('Failed to process pending log:', error);
            }
        }
        this.pendingLogs = [];
    }

    async loadSettings() {
        const data = await this.loadData();
        this.settings = { ...DEFAULT_SETTINGS, ...data};

        if (this.settings.azure) {
            this.settings.azure.accessKey = this.deobfuscate(this.settings.azure.accessKey);
        }
        if (this.settings.aws) {
            this.settings.aws.accessKey = this.deobfuscate(this.settings.aws.accessKey);
            this.settings.aws.secretKey = this.deobfuscate(this.settings.aws.secretKey);
        }
        if (this.settings.gcp) {
            this.settings.gcp.privateKey = this.deobfuscate(this.settings.gcp.privateKey);
        }

        LogManager.log(LogLevel.Debug, 'Settings loaded');
    }

    async saveSettings() {
        const settingsToSave = JSON.parse(JSON.stringify(this.settings));

        if (settingsToSave.azure) {
            settingsToSave.azure.accessKey = this.obfuscate(settingsToSave.azure.accessKey);
        }
        if (settingsToSave.aws) {
            settingsToSave.aws.accessKey = this.obfuscate(settingsToSave.aws.accessKey);
            settingsToSave.aws.secretKey = this.obfuscate(settingsToSave.aws.secretKey);
        }
        if (settingsToSave.gcp) {
            settingsToSave.gcp.privateKey = this.obfuscate(settingsToSave.gcp.privateKey);
        }

        await this.saveData(settingsToSave);
        LogManager.log(LogLevel.Debug, 'Settings saved');
    }

    async handleLogLevelChange(newLevel: LogLevel) {
        if (newLevel === LogLevel.None) {
            this.app.workspace.detachLeavesOfType(LOG_VIEW_TYPE);
        } else if (this.settings.logLevel === LogLevel.None) {
            await this.activateLogView();
        }
        this.settings.logLevel = newLevel;
    }

    private async activateLogView() {
        try {
            if (this.settings.logLevel === LogLevel.None) {
                return;
            }

            if (this.app.workspace.getLeavesOfType(LOG_VIEW_TYPE).length === 0) {
                const leaf = await this.app.workspace.getRightLeaf(false);
                if (leaf) {
                    await leaf.setViewState({
                        type: LOG_VIEW_TYPE,
                        active: true,
                    });
                    this.app.workspace.revealLeaf(leaf);
                }
            } else {
                const leaves = this.app.workspace.getLeavesOfType(LOG_VIEW_TYPE);
                if (leaves.length > 0) {
                    this.app.workspace.revealLeaf(leaves[0]);
                }
            }
        } catch (error) {
            console.debug('CloudSync: Log view activation deferred:', error);
        }
    }

    async onunload() {
        LogManager.log(LogLevel.Trace, 'Unloading plugin...');
        try {
            // Clean up all registered resources and services
            await cleanupContainer(this.app);
            LogManager.log(LogLevel.Info, 'Plugin unloaded successfully');
        } catch (error) {
            LogManager.log(LogLevel.Error, 'Error during plugin cleanup', error);
            new Notice('Error during plugin cleanup. Some resources may not have been properly released.');
        }
    }

    async cleanup(): Promise<void> {
        if (this.timer) {
            ResourceManager.clearTimer(this.timer);
            this.timer = null;
        }
    }

    private shouldLog(type: Exclude<LogType, 'delimiter'>): boolean {
        switch (this.settings.logLevel) {
            case LogLevel.None:
                return false;
            case LogLevel.Info:
                return type === 'error' || type === 'info';
            case LogLevel.Trace:
                return type === 'error' || type === 'info' || type === 'trace';
            case LogLevel.Debug:
                return true;
            default:
                return false;
        }
    }

    private baseLog(message: string, type: LogType = 'info', update = false, important = false): void {
        if (type === 'delimiter') {
            const logView = this.getLogView();
            if (logView?.addLogEntry) {
                try {
                    logView.addLogEntry('', type);
                } catch (error) {
                    console.debug('Failed to add delimiter log entry:', error);
                    this.pendingLogs.push({message: '', type, update});
                }
            } else {
                this.pendingLogs.push({message: '', type, update});
            }
            return;
        }

        if (this.settings.logLevel === LogLevel.None && (type === 'error' || (type === 'info' && important))) {
            const prefix = type === 'error' ? 'CloudSync Error: ' : 'CloudSync: ';
            const timeout = type === 'error' ? 10000 : 5000;
            const notice = new Notice(`${prefix}${message}`, timeout);
            notice.noticeEl.addClass(type === 'error' ? 'cloud-sync-error-notice' : 'cloud-sync-info-notice');
            return;
        }

        if (!this.shouldLog(type)) {
            return;
        }

        const shouldUpdate = update && this.settings.logLevel === LogLevel.Info;

        const logView = this.getLogView();
        if (logView?.addLogEntry) {
            try {
                logView.addLogEntry(message, type, shouldUpdate);
            } catch (error) {
                console.debug('Failed to add log entry:', error);
                this.pendingLogs.push({message, type, update: shouldUpdate});
            }
        } else {
            this.pendingLogs.push({message, type, update: shouldUpdate});
        }
    }
}
