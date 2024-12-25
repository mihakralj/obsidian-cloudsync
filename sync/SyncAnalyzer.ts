import { AbstractManager, File } from "./AbstractManager";
import { LogManager } from "../LogManager";
import { LogLevel } from "./types";
import { Strings } from "./utils/strings";
import { SyncError, CacheError } from "./errors";
import { Scenario } from "./types/sync";
import { CacheManager } from "./CacheManager";
import { LocalManager } from "./localManager";
import { dirname } from "path-browserify";
import { normalizePath } from "obsidian";

export class SyncAnalyzer {
    private localFiles: File[] = [];
    private remoteFiles: File[] = [];
    private readonly localCache: CacheManager;

    constructor(
        private readonly local: AbstractManager,
        private readonly remote: AbstractManager,
        private readonly syncCache: CacheManager
    ) {
        const pluginDir = dirname(syncCache['cacheFilePath']);
        const localCachePath = normalizePath(`${pluginDir}/cloudsync-local.json`);
        const localManager = local as LocalManager;
        this.localCache = CacheManager.getInstance(localCachePath, localManager.getApp());
    }

    async analyze(): Promise<Scenario[]> {
        const scenarios: Scenario[] = [];

        try {
            try {
                await Promise.all([
                    this.localCache.readCache().catch(error => {
                        throw new CacheError('read local cache', error.message);
                    }),
                    this.syncCache.readCache().catch(error => {
                        throw new CacheError('read sync cache', error.message);
                    })
                ]);
            } catch (error) {
                throw new SyncError('cache initialization', error.message);
            }

            try {
                [this.localFiles, this.remoteFiles] = await Promise.all([
                    this.local.getFiles().catch(error => {
                        throw new SyncError('local file listing', error.message);
                    }),
                    this.remote.getFiles().catch(error => {
                        if (error instanceof Error && error.message === 'NEW_CONTAINER') {
                            return [];
                        }
                        throw new SyncError('remote file listing', error.message);
                    })
                ]);
            } catch (error) {
                throw new SyncError('file listing', error.message);
            }

            LogManager.log(LogLevel.Info, `${this.remote.name} ${Strings.REMOTE}: ${this.remoteFiles.length}`);

            // If remote is empty and it's a new container, force upload all local files
            if (this.remoteFiles.length === 0 && this.localFiles.length > 0) {
                LogManager.log(LogLevel.Info, 'New remote location detected, uploading all local files');
                for (const localFile of this.localFiles) {
                    scenarios.push({
                        local: localFile,
                        remote: null,
                        rule: "LOCAL_TO_REMOTE",
                    });
                }
            } else {
                this.analyzeLocalFiles(scenarios);
                this.analyzeRemoteFiles(scenarios);
            }

            if (scenarios.length > 0) {
                LogManager.log(LogLevel.Info, `${Strings.SYNC_COUNT} ${scenarios.length}`);
            }

            return scenarios;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            LogManager.log(LogLevel.Error, 'Failed to analyze sync requirements', error);
            throw new SyncError('analysis', message);
        }
    }

    private analyzeLocalFiles(scenarios: Scenario[]): void {
        this.localFiles.forEach((localFile) => {
            const remoteFile = this.remoteFiles.find(f => {
                LogManager.log(LogLevel.Trace, `Comparing files:
                    Local: name=${localFile.name}, remoteName=${localFile.remoteName}
                    Remote: name=${f.name}, remoteName=${f.remoteName}`);
                return f.remoteName === localFile.remoteName;
            });

            if (!remoteFile) {
                this.handleMissingRemoteFile(localFile, scenarios);
            } else if (localFile.md5 !== remoteFile.md5) {
                this.handleFileDifference(localFile, remoteFile, scenarios);
            }
        });
    }

    private analyzeRemoteFiles(scenarios: Scenario[]): void {
        this.remoteFiles.forEach((remoteFile) => {
            const localFile = this.localFiles.find(f => {
                LogManager.log(LogLevel.Trace, `Comparing files:
                    Remote: name=${remoteFile.name}, remoteName=${remoteFile.remoteName}
                    Local: name=${f.name}, remoteName=${f.remoteName}`);
                return f.remoteName === remoteFile.remoteName;
            });
            if (!localFile) {
                this.handleMissingLocalFile(remoteFile, scenarios);
            }
        });
    }

    private handleMissingRemoteFile(localFile: File, scenarios: Scenario[]): void {
        try {
            const syncedMd5 = this.syncCache.getMd5(localFile.name);
            const localCachedMd5 = this.localCache.getMd5(localFile.name);

            if (!syncedMd5) {
                scenarios.push({
                    local: localFile,
                    remote: null,
                    rule: "LOCAL_TO_REMOTE",
                });
                LogManager.log(LogLevel.Debug, `New local file, uploading: ${localFile.name}`);
            } else if (localCachedMd5 && localCachedMd5 === syncedMd5) {
                // Only delete local if we're not dealing with a new container
                if (this.remoteFiles.length > 0) {
                    scenarios.push({
                        local: localFile,
                        remote: null,
                        rule: "DELETE_LOCAL",
                    });
                    LogManager.log(LogLevel.Debug, `File unchanged since last sync, deleting locally: ${localFile.name}`);
                } else {
                    scenarios.push({
                        local: localFile,
                        remote: null,
                        rule: "LOCAL_TO_REMOTE",
                    });
                    LogManager.log(LogLevel.Debug, `New container detected, re-uploading: ${localFile.name}`);
                }
            } else {
                scenarios.push({
                    local: localFile,
                    remote: null,
                    rule: "LOCAL_TO_REMOTE",
                });
                LogManager.log(LogLevel.Debug, `Local file modified, re-uploading: ${localFile.name}`);
            }
        } catch (error) {
            throw new SyncError('missing remote analysis', `Failed to analyze ${localFile.name}: ${error.message}`);
        }
    }

    private handleMissingLocalFile(remoteFile: File, scenarios: Scenario[]): void {
        try {
            if (this.syncCache.hasFile(remoteFile.name)) {
                scenarios.push({
                    local: null,
                    remote: remoteFile,
                    rule: "DELETE_REMOTE",
                });
                LogManager.log(LogLevel.Debug, `File deleted locally, removing from remote: ${remoteFile.name}`);
            } else {
                scenarios.push({
                    local: null,
                    remote: remoteFile,
                    rule: "REMOTE_TO_LOCAL",
                });
                LogManager.log(LogLevel.Debug, `New remote file, downloading: ${remoteFile.name}`);
            }
        } catch (error) {
            throw new SyncError('missing local analysis', `Failed to analyze ${remoteFile.name}: ${error.message}`);
        }
    }

    private handleFileDifference(localFile: File, remoteFile: File, scenarios: Scenario[]): void {
        try {
            const syncedMd5 = this.syncCache.getMd5(localFile.name);
            const localCachedMd5 = this.localCache.getMd5(localFile.name);

            if (syncedMd5 && syncedMd5 === remoteFile.md5) {
                scenarios.push({
                    local: localFile,
                    remote: remoteFile,
                    rule: "LOCAL_TO_REMOTE",
                });
                LogManager.log(LogLevel.Debug, `Local changes detected, uploading: ${localFile.name}`);
            } else if (localCachedMd5 && localCachedMd5 === localFile.md5) {
                scenarios.push({
                    local: localFile,
                    remote: remoteFile,
                    rule: "REMOTE_TO_LOCAL",
                });
                LogManager.log(LogLevel.Debug, `Remote changes detected, downloading: ${localFile.name}`);
            } else {
                scenarios.push({
                    local: localFile,
                    remote: remoteFile,
                    rule: "DIFF_MERGE",
                });
                LogManager.log(LogLevel.Debug, `Conflict detected, needs merge: ${localFile.name}`);
            }
        } catch (error) {
            throw new SyncError('file difference analysis', `Failed to analyze differences for ${localFile.name}: ${error.message}`);
        }
    }
}
