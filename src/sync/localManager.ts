import { AbstractManager, File } from './AbstractManager';
import { CloudSyncSettings, LogLevel } from './types';
import { Strings } from './utils/strings';
import { basename, dirname } from 'path-browserify';
import * as CryptoJS from 'crypto-js';
import { getType } from 'mime/lite';
import { LogManager } from '../LogManager';
import { App, FileStats, normalizePath } from 'obsidian';
import { CacheManager } from './CacheManager';
interface HashCacheEntry {
    hash: string;
    mtime: Date;
    mimeType: string;
    size: number;
    utcTimestamp: string;
}

export class LocalManager extends AbstractManager {
    public readonly name: string = 'Local';
    private readonly MAX_CONCURRENT = 50;

    private readonly vaultName: string;
    private readonly hashCache: {
        [filePath: string]: HashCacheEntry;
    } = {};
    private cacheHits = 0;
    private cacheMisses = 0;
    private readonly localCache: CacheManager;

    constructor(
        settings: CloudSyncSettings,
        private readonly app: App,
        private readonly syncCache: CacheManager
    ) {
        super(settings);
        this.vaultName = this.app.vault.getName();
        const localCachePath = normalizePath(`${this.app.vault.configDir}/plugins/cloudsync/cloudsync-local.json`);
        this.localCache = CacheManager.getInstance(localCachePath, this.app);

        LogManager.log(LogLevel.Debug, 'Local vault manager initialized', {
            vault: this.vaultName,
            maxConcurrent: this.MAX_CONCURRENT
        });
    }

    public getApp(): App {
        return this.app;
    }

    private getDefaultIgnoreList(): string[] {
        return [
            `${this.app.vault.configDir}/plugins/cloudsync`,
            `${this.app.vault.configDir}/workspace.json`,
            '.git',
            '.gitignore',
            '.trash',
            '.hotreload',
            '.DS_Store'
        ];
    }

    private getIgnoreList(): string[] {
        LogManager.log(LogLevel.Trace, 'Building ignore list');
        const ignoreList = [...this.getDefaultIgnoreList()];

        if (this.settings.syncIgnore) {
            const userIgnoreItems = this.settings.syncIgnore
                .split(',')
                .map(item => item.trim())
                .filter(item => item.length > 0);

            userIgnoreItems.forEach(item => {
                if (!ignoreList.includes(item)) {
                    ignoreList.push(item);
                    // Also add normalized version if it's a path
                    if (item.includes('/')) {
                        ignoreList.push(normalizePath(item));
                    }
                }
            });
        }

        LogManager.log(LogLevel.Debug, 'Ignore list compiled', { ignoreList });
        return ignoreList;
    }

    public getVaultName(): string {
        return this.vaultName;
    }

    public getSettings(): CloudSyncSettings {
        return this.settings;
    }

    private normalizeVaultPath(path: string): string {
        return normalizePath(path);
    }

    private async ensureDirectoryExists(filePath: string): Promise<void> {
        const dirPath = dirname(filePath);
        if (dirPath === '.') return;

        const exists = await this.app.vault.adapter.exists(dirPath);
        if (!exists) {
            LogManager.log(LogLevel.Debug, `Creating directory: ${dirPath}`);
            await this.app.vault.adapter.mkdir(dirPath);
        }
    }

    private async computeHashStreaming(path: string): Promise<string> {
        LogManager.log(LogLevel.Trace, `Computing hash for: ${path}`);
        const arrayBuffer = await this.app.vault.adapter.readBinary(path);
        const wordArray = CryptoJS.lib.WordArray.create(arrayBuffer);
        return CryptoJS.MD5(wordArray).toString(CryptoJS.enc.Hex);
    }

    private async processFileWithCache(
        filePath: string,
        stats: FileStats,
        normalizedPath: string
    ): Promise<File | null> {
        LogManager.log(LogLevel.Trace, `Processing file: ${filePath}`);

        try {
            const mtime = new Date(stats.mtime);
            const mimeType = getType(filePath) ?? "application/octet-stream";

            const cachedTimestamp = this.localCache.getTimestamp(normalizedPath);
            if (cachedTimestamp && cachedTimestamp.getTime() === mtime.getTime()) {
                const cachedMd5 = this.localCache.getMd5(normalizedPath);
                if (cachedMd5) {
                    LogManager.log(LogLevel.Trace, `Cache hit for ${filePath}`);
                    this.cacheHits++;
                    return {
                        name: normalizedPath,
                        localName: filePath,
                        remoteName: normalizedPath,
                        mime: mimeType,
                        size: stats.size,
                        md5: cachedMd5,
                        lastModified: mtime,
                        isDirectory: false,
                    };
                }
            }

            this.cacheMisses++;
            const hash = await this.computeHashStreaming(filePath);

            LogManager.log(LogLevel.Trace, `Using raw name for remote: ${normalizedPath}`);
            return {
                name: normalizedPath,
                localName: filePath,
                remoteName: normalizedPath,
                mime: mimeType,
                size: stats.size,
                md5: hash,
                lastModified: mtime,
                isDirectory: false,
            };
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to process file: ${filePath}`, error);
            return null;
        }
    }

    private async processFilesBatch(filePaths: string[]): Promise<File[]> {
        LogManager.log(LogLevel.Debug, `Processing batch of ${filePaths.length} files`);

        const results = await Promise.all(
            filePaths.map(async (filePath) => {
                const stats = await this.app.vault.adapter.stat(filePath);
                if (!stats) return null;

                const normalizedPath = this.normalizeVaultPath(filePath);
                return this.processFileWithCache(filePath, stats, normalizedPath);
            })
        );

        const validResults = results.filter((f): f is File => f !== null);
        LogManager.log(LogLevel.Debug, 'Batch processing completed', {
            total: filePaths.length,
            successful: validResults.length,
            failed: filePaths.length - validResults.length
        });

        return validResults;
    }

    private async processBatchesSequentially(filePaths: string[]): Promise<File[]> {
        const results: File[] = [];
        const chunks: string[][] = [];

        LogManager.log(LogLevel.Debug, `Starting sequential batch processing for ${filePaths.length} files`);

        for (let i = 0; i < filePaths.length; i += this.MAX_CONCURRENT) {
            chunks.push(filePaths.slice(i, i + this.MAX_CONCURRENT));
        }

        LogManager.log(LogLevel.Debug, `Split into ${chunks.length} batches of max ${this.MAX_CONCURRENT} files each`);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            LogManager.log(LogLevel.Trace, `Processing batch ${i + 1}/${chunks.length} (${chunk.length} files)`);
            const chunkResults = await this.processFilesBatch(chunk);
            results.push(...chunkResults);
        }

        LogManager.log(LogLevel.Debug, 'Sequential batch processing completed', {
            totalFiles: filePaths.length,
            totalBatches: chunks.length,
            successfulFiles: results.length,
            cacheHits: this.cacheHits,
            cacheMisses: this.cacheMisses,
            cacheHitRate: `${Math.round((this.cacheHits / (this.cacheHits + this.cacheMisses)) * 100)}%`
        });

        return results;
    }

    public override async getFiles(directory: string = ''): Promise<File[]> {
        LogManager.log(LogLevel.Debug, `Scanning directory: ${directory || '/'}`);

        try {
            if (!directory) {
                await this.localCache.readCache();
            }

            const ignoreList = this.getIgnoreList();

            if (ignoreList.includes(basename(directory))) {
                LogManager.log(LogLevel.Debug, `Skipping ignored directory: ${directory}`);
                return [];
            }

            const listing = await this.app.vault.adapter.list(directory || '/');
            LogManager.log(LogLevel.Trace, `Directory listing completed`, {
                files: listing.files.length,
                folders: listing.folders.length
            });

            const validFiles = listing.files.filter(filePath =>
                !ignoreList.some(ignorePath =>
                    filePath.startsWith(ignorePath) ||
                    basename(filePath) === ignorePath
                )
            );

            LogManager.log(LogLevel.Debug, `Found ${validFiles.length} files to process after filtering`);

            const files = await this.processBatchesSequentially(validFiles);

            const validFolders = listing.folders.filter(folderPath =>
                !ignoreList.some(ignorePath =>
                    folderPath.startsWith(ignorePath) ||
                    basename(folderPath) === ignorePath
                )
            );

            LogManager.log(LogLevel.Debug, `Processing ${validFolders.length} subdirectories in parallel`);

            const directoryFiles = await Promise.all(
                validFolders.map(folderPath =>
                    this.getFiles(folderPath)
                )
            );

            // Filter out empty directory results
            const nonEmptyDirectoryFiles = directoryFiles.filter(files => files.length > 0);
            const flattenedDirectoryFiles = nonEmptyDirectoryFiles.reduce((acc, curr) => acc.concat(curr), []);
            this.files = [...files, ...flattenedDirectoryFiles];

            if (!directory && this.files.length > 0) {
                await this.localCache.writeCache(this.files);
            }

            if (!directory) {
                LogManager.log(LogLevel.Info, `Vault ${Strings.LOCAL}: ${this.files.length}`);
                LogManager.log(LogLevel.Debug, 'Full vault scan completed', {
                    totalFiles: this.files.length,
                    cacheHits: this.cacheHits,
                    cacheMisses: this.cacheMisses,
                    cacheHitRate: `${Math.round((this.cacheHits / (this.cacheHits + this.cacheMisses)) * 100)}%`
                });
            }

            return this.files;
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to scan directory: ${directory}`, error);
            throw error;
        }
    }

    async authenticate(): Promise<void> {
        LogManager.log(LogLevel.Debug, 'Verifying local vault access');
        LogManager.log(LogLevel.Trace, 'Local vault access verified');
    }

    async testConnectivity(): Promise<{ success: boolean; message: string; details?: unknown }> {
        try {
            LogManager.log(LogLevel.Debug, 'Testing local vault read/write access');
            const testFile = '.test';
            const encoder = new TextEncoder();
            await this.app.vault.adapter.writeBinary(testFile, encoder.encode('test').buffer as ArrayBuffer);
            await this.app.vault.adapter.remove(testFile);

            LogManager.log(LogLevel.Trace, 'Local vault access test successful');
            return {
                success: true,
                message: "Successfully verified local vault access"
            };
        } catch (error) {
            LogManager.log(LogLevel.Error, 'Failed to verify local vault access', error);
            return {
                success: false,
                message: `Local vault access failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                details: error
            };
        }
    }

    async readFile(file: File): Promise<Uint8Array> {
        if (!file?.localName) {
            throw new Error('Invalid file parameter: missing localName');
        }

        LogManager.log(LogLevel.Debug, `Reading file: ${file.name}`);
        try {
            const arrayBuffer = await this.app.vault.adapter.readBinary(file.localName);
            LogManager.log(LogLevel.Debug, `File read completed: ${file.name}`, {
                size: arrayBuffer.byteLength
            });
            return new Uint8Array(arrayBuffer);
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to read file: ${file.name}`, error);
            throw error;
        }
    }

    async writeFile(file: File, content: Uint8Array): Promise<void> {
        if (!file?.localName) {
            throw new Error('Invalid file parameter: missing localName');
        }
        if (!content) {
            throw new Error('Invalid content parameter: missing content');
        }

        LogManager.log(LogLevel.Debug, `Writing file: ${file.name} (${content.length} bytes)`);
        try {
            await this.ensureDirectoryExists(file.localName);
            await this.app.vault.adapter.writeBinary(file.localName, content.buffer as ArrayBuffer);
            LogManager.log(LogLevel.Debug, `File write completed: ${file.name}`, {
                size: content.length
            });
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to write file: ${file.name}`, error);
            throw error;
        }
    }

    async deleteFile(file: File): Promise<void> {
        if (!file?.localName) {
            throw new Error('Invalid file parameter: missing localName');
        }

        LogManager.log(LogLevel.Debug, `Deleting file: ${file.name}`);
        try {
            await this.app.vault.adapter.remove(file.localName);
            LogManager.log(LogLevel.Debug, `File deletion completed: ${file.name}`);
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to delete file: ${file.name}`, error);
            throw error;
        }
    }
}
