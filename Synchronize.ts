import { AbstractManager, File } from "./AbstractManager";
import { writeFile, readFile } from "fs/promises";
import { diff_match_patch } from "diff-match-patch";
import { LogManager } from "./LogManager";
import { LogLevel } from "./types";
import { join, dirname, sep, posix, normalize } from "path";
import { mkdir } from "fs/promises";

export interface Scenario {
    local: File | null;
    remote: File | null;
    rule: SyncRule;
}

export type SyncRule =
    | "LOCAL_TO_REMOTE"
    | "REMOTE_TO_LOCAL"
    | "DIFF_MERGE"
    | "DELETE_LOCAL"
    | "DELETE_REMOTE"
    | "TO_CACHE";

export class Synchronize {
    private local: AbstractManager;
    private remote: AbstractManager;
    private localFiles: File[];
    private remoteFiles: File[];
    private cacheFilePath: string;
    private fileCache: Map<string, string>;
    private lastSync: Date;

    constructor(local: AbstractManager, remote: AbstractManager, cacheFilePath: string) {
        this.local = local;
        this.remote = remote;
        this.localFiles = [];
        this.remoteFiles = [];
        this.cacheFilePath = cacheFilePath;
        this.fileCache = new Map();
        this.lastSync = new Date(0);

        const vaultName = (this.local as any).getVaultName?.() || 'default';
        this.log(LogLevel.Debug, 'Synchronize initialized', {
            vault: vaultName,
            provider: this.remote.name,
            cacheFile: this.cacheFilePath
        });
    }

    private log(level: LogLevel, message: string, data?: any): void {
        LogManager.log(level, message, data);
    }

    private async ensureDirectoryExists(filePath: string): Promise<void> {
        const fullPath = normalize(filePath);
        const directory = dirname(fullPath);
        const segments = directory.split(sep);
        let currentPath = segments[0];

        for (let i = 1; i < segments.length; i++) {
            currentPath = join(currentPath, segments[i]);
            try {
                await mkdir(currentPath);
                this.log(LogLevel.Debug, `Created directory ${currentPath}`);
            } catch (error: any) {
                if (error.code !== 'EEXIST') {
                    this.log(LogLevel.Error, `Failed to create directory ${currentPath}`, error);
                    throw error;
                }
            }
        }
    }

    private normalizeLocalPath(basePath: string, relativePath: string): string {
        const normalizedRelative = relativePath.split(posix.sep).join(sep);
        return normalize(join(basePath, normalizedRelative));
    }

    async readFileCache(): Promise<void> {
        try {
            const fileCacheJson = await readFile(this.cacheFilePath, "utf-8");
            const { lastSync, fileCache } = JSON.parse(fileCacheJson);
            this.lastSync = new Date(lastSync);
            this.fileCache = new Map(fileCache);
            this.log(LogLevel.Debug, `Cache loaded with ${this.fileCache.size} entries from ${this.cacheFilePath}`);
        } catch (error) {
            this.log(LogLevel.Debug, 'No existing cache found, starting fresh');
            this.lastSync = new Date(0);
            this.fileCache.clear();
        }
    }

    async writeFileCache(processedFiles: File[]): Promise<void> {
        try {
            this.fileCache.clear();
            processedFiles.forEach((file) => {
                this.fileCache.set(file.name, file.md5);
            });
            const fileCacheArray = Array.from(this.fileCache.entries());
            const fileCacheJson = JSON.stringify({
                lastSync: this.lastSync,
                fileCache: fileCacheArray,
            }, null, 2);
            await writeFile(this.cacheFilePath, fileCacheJson);
            this.log(LogLevel.Debug, `Cache updated with ${this.fileCache.size} entries`);
        } catch (error) {
            this.log(LogLevel.Error, 'Failed to write cache file', error);
            throw error;
        }
    }

    async syncActions(): Promise<Scenario[]> {
        this.log(LogLevel.Trace, 'Analyzing sync requirements...');
        const scenarios: Scenario[] = [];

        try {
            const [localFiles, remoteFiles] = await Promise.all([
                this.local.getFiles(),
                this.remote.getFiles(),
                this.readFileCache()
            ]);

            this.localFiles = localFiles;
            this.remoteFiles = remoteFiles;

            this.log(LogLevel.Info, `Found ${this.localFiles.length} local files and ${this.remoteFiles.length} ${this.remote.name} files`);

            // Handle local files
            this.localFiles.forEach((localFile) => {
                const remoteFile = this.remoteFiles.find(
                    (f) => f.name === localFile.name
                );

                if (!remoteFile) {
                    if (!this.fileCache.has(localFile.name)) {
                        scenarios.push({
                            local: localFile,
                            remote: null,
                            rule: "LOCAL_TO_REMOTE",
                        });
                        this.log(LogLevel.Debug, `New local file detected: ${localFile.name}`);
                    } else {
                        scenarios.push({
                            local: localFile,
                            remote: null,
                            rule: "DELETE_LOCAL",
                        });
                        this.log(LogLevel.Debug, `File deleted remotely: ${localFile.name}`);
                    }
                } else if (localFile.md5 !== remoteFile.md5) {
                    const cachedMd5 = this.fileCache.get(localFile.name);
                    if (cachedMd5 && cachedMd5 === remoteFile.md5) {
                        scenarios.push({
                            local: localFile,
                            remote: remoteFile,
                            rule: "LOCAL_TO_REMOTE",
                        });
                        this.log(LogLevel.Debug, `Local changes detected: ${localFile.name}`);
                    } else if (cachedMd5 && cachedMd5 === localFile.md5) {
                        scenarios.push({
                            local: localFile,
                            remote: remoteFile,
                            rule: "REMOTE_TO_LOCAL",
                        });
                        this.log(LogLevel.Debug, `Remote changes detected: ${localFile.name}`);
                    } else {
                        scenarios.push({
                            local: localFile,
                            remote: remoteFile,
                            rule: "DIFF_MERGE",
                        });
                        this.log(LogLevel.Debug, `Conflicting changes detected: ${localFile.name}`);
                    }
                }
            });

            // Handle remote files
            this.remoteFiles.forEach((remoteFile) => {
                const localFile = this.localFiles.find((f) => f.name === remoteFile.name);
                if (!localFile) {
                    if (!this.fileCache.has(remoteFile.name)) {
                        scenarios.push({
                            local: null,
                            remote: remoteFile,
                            rule: "REMOTE_TO_LOCAL",
                        });
                        this.log(LogLevel.Debug, `New remote file detected: ${remoteFile.name}`);
                    } else {
                        scenarios.push({
                            local: null,
                            remote: remoteFile,
                            rule: "DELETE_REMOTE",
                        });
                        this.log(LogLevel.Debug, `File deleted locally: ${remoteFile.name}`);
                    }
                }
            });

            // Summarize actions
            const ruleCounts = scenarios.reduce((acc, s) => {
                acc[s.rule] = (acc[s.rule] || 0) + 1;
                return acc;
            }, {} as Record<SyncRule, number>);

            if (scenarios.length > 0) {
                this.log(LogLevel.Info, `${this.remote.name} sync plan:`, Object.entries(ruleCounts)
                    .filter(([_, count]) => count > 0)
                    .map(([rule, count]) => `${rule}: ${count}`)
                    .join(', '));
            } else {
                this.log(LogLevel.Info, `All files are in sync with ${this.remote.name}`);
            }

            return scenarios;
        } catch (error) {
            this.log(LogLevel.Error, 'Failed to analyze sync requirements', error);
            throw error;
        }
    }

    async runAllScenarios(scenarios: Scenario[]): Promise<void> {
        this.log(LogLevel.Trace, `Starting sync of ${scenarios.length} changes with ${this.remote.name}...`);

        try {
            for (const scenario of scenarios) {
                try {
                    const fileName = scenario.local?.name || scenario.remote?.name;
                    this.log(LogLevel.Trace, `Processing ${scenario.rule} for ${fileName}`);

                    switch (scenario.rule) {
                        case "LOCAL_TO_REMOTE":
                            if (scenario.local) {
                                await this.copyToRemote(scenario.local);
                            }
                            break;
                        case "REMOTE_TO_LOCAL":
                            if (scenario.remote) {
                                await this.copyToLocal(scenario.remote);
                            }
                            break;
                        case "DELETE_LOCAL":
                            if (scenario.local) {
                                await this.deleteFromLocal(scenario.local);
                            }
                            break;
                        case "DELETE_REMOTE":
                            if (scenario.remote) {
                                await this.deleteFromRemote(scenario.remote);
                            }
                            break;
                        case "DIFF_MERGE":
                            if (scenario.local && scenario.remote) {
                                await this.diffMerge(scenario.local);
                            }
                            break;
                    }
                } catch (error) {
                    const fileName = scenario.local?.name || scenario.remote?.name;
                    this.log(LogLevel.Error, `Failed to process ${scenario.rule} for ${fileName}`, error);
                    throw error;
                }
            }

            this.lastSync = new Date();
            this.remoteFiles = await this.remote.getFiles();
            await this.writeFileCache(this.remoteFiles);

            this.log(LogLevel.Info, `${this.remote.name} sync completed successfully`);

        } catch (error) {
            this.log(LogLevel.Error, `${this.remote.name} sync failed`, error);
            throw error;
        }
    }

    async copyToRemote(file: File): Promise<void> {
        this.log(LogLevel.Debug, `Preparing to upload ${file.name} to ${this.remote.name}`);

        try {
            const content = await this.local.readFile(file);
            await this.remote.writeFile(file, content);
            this.log(LogLevel.Trace, `Uploaded ${file.name} to ${this.remote.name}`);
        } catch (error) {
            this.log(LogLevel.Error, `Failed to upload ${file.name} to ${this.remote.name}`, error);
            throw error;
        }
    }

    async copyToLocal(file: File): Promise<void> {
        this.log(LogLevel.Debug, `Preparing to download ${file.name} from ${this.remote.name}`);

        try {
            const content = await this.remote.readFile(file);
            const basePath = (this.local as any).basePath;
            if (basePath) {
                file.localName = this.normalizeLocalPath(basePath, file.name);
                this.log(LogLevel.Debug, `Creating directory structure for ${file.localName}`);
                await this.ensureDirectoryExists(file.localName);
            }
            await this.local.writeFile(file, content);
            this.log(LogLevel.Trace, `Downloaded ${file.name} from ${this.remote.name}`);
        } catch (error) {
            this.log(LogLevel.Error, `Failed to download ${file.name} from ${this.remote.name}`, error);
            throw error;
        }
    }

    async deleteFromRemote(file: File): Promise<void> {
        this.log(LogLevel.Debug, `Preparing to delete ${file.name} from ${this.remote.name}`);
        try {
            await this.remote.deleteFile(file);
            this.log(LogLevel.Trace, `Deleted ${file.name} from ${this.remote.name}`);
        } catch (error) {
            this.log(LogLevel.Error, `Failed to delete ${file.name} from ${this.remote.name}`, error);
            throw error;
        }
    }

    async deleteFromLocal(file: File): Promise<void> {
        this.log(LogLevel.Debug, `Preparing to delete ${file.name} from local`);
        try {
            await this.local.deleteFile(file);
            this.log(LogLevel.Trace, `Deleted ${file.name} from local`);
        } catch (error) {
            this.log(LogLevel.Error, `Failed to delete ${file.name} from local`, error);
            throw error;
        }
    }

    async diffMerge(file: File): Promise<void> {
        this.log(LogLevel.Debug, `Starting merge for ${file.name}`);
        try {
            this.log(LogLevel.Debug, 'Reading file versions');
            const [localBuffer, remoteBuffer] = await Promise.all([
                this.local.readFile(file),
                this.remote.readFile(file)
            ]);

            const localContent = localBuffer.toString();
            const remoteContent = remoteBuffer.toString();
            const localLines = localContent.split("\n");
            const remoteLines = remoteContent.split("\n");

            this.log(LogLevel.Debug, `Computing differences between versions (${localLines.length} local lines, ${remoteLines.length} remote lines)`);
            const dmp = new diff_match_patch();
            const diffs = dmp.diff_main(localLines.join("\n"), remoteLines.join("\n"));
            dmp.diff_cleanupSemantic(diffs);

            const mergedLines = [...localLines];
            let insertCount = 0;

            this.log(LogLevel.Debug, 'Applying changes');
            for (const [operation, text] of diffs) {
                if (operation === diff_match_patch.DIFF_INSERT) {
                    const lines = text.split("\n");
                    lines.pop();
                    const index = mergedLines.indexOf(localLines[0]);
                    mergedLines.splice(index, 0, ...lines);
                    insertCount++;
                }
            }

            const mergedBuffer = Buffer.from(mergedLines.join("\n"));

            this.log(LogLevel.Debug, 'Writing merged version');
            await Promise.all([
                this.local.writeFile(file, mergedBuffer),
                this.remote.writeFile(file, mergedBuffer)
            ]);

            this.log(LogLevel.Trace, `Merged ${file.name} (${insertCount} insertions)`);
        } catch (error) {
            this.log(LogLevel.Error, `Failed to merge ${file.name}`, error);
            throw error;
        }
    }
}
