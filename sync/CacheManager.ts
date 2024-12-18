import { File } from "./AbstractManager";
import { LogManager } from "../LogManager";
import { LogLevel } from "./types";
import { CacheError, FileOperationError } from "./errors";
import { App, normalizePath } from "obsidian";
import { dirname } from "path-browserify";

interface CacheEntry {
    md5: string;
    utcTimestamp: string;
}

export class CacheManager {
    private fileCache: Map<string, CacheEntry> = new Map();
    private lastSync: Date | null = null;
    private static instances: Map<string, CacheManager> = new Map();
    private encoder = new TextEncoder();
    private decoder = new TextDecoder();

    private constructor(
        private readonly cacheFilePath: string,
        private readonly app: App
    ) {}

    static getInstance(cacheFilePath: string, app: App): CacheManager {
        if (!this.instances.has(cacheFilePath)) {
            this.instances.set(cacheFilePath, new CacheManager(cacheFilePath, app));
        }
        return this.instances.get(cacheFilePath)!;
    }

    private getVaultRelativePath(): string {
        return normalizePath(this.cacheFilePath);
    }

    private async ensureCacheDirectoryExists(): Promise<void> {
        const relativePath = this.getVaultRelativePath();
        const dirPath = dirname(relativePath);

        if (dirPath === '.') return;

        try {
            const exists = await this.app.vault.adapter.exists(dirPath);
            if (!exists) {
                LogManager.log(LogLevel.Debug, `Creating cache directory: ${dirPath}`);
                await this.app.vault.adapter.mkdir(dirPath);
            }
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to create cache directory: ${dirPath}`, error);
            throw error;
        }
    }

    async readCache(): Promise<void> {
        try {
            LogManager.log(LogLevel.Debug, 'Reading cache file');
            const relativePath = this.getVaultRelativePath();
            const exists = await this.app.vault.adapter.exists(relativePath);

            if (!exists) {
                LogManager.log(LogLevel.Debug, 'No cache file found, initializing empty cache');
                this.fileCache = new Map();
                this.lastSync = null;
                return;
            }

            if (!this.app.vault.adapter) {
                throw new CacheError('read', 'Vault adapter not available');
            }

            try {
                const arrayBuffer = await this.app.vault.adapter.readBinary(relativePath);
                const content = this.decoder.decode(arrayBuffer);
                const { lastSync, fileCache } = JSON.parse(content);
            this.lastSync = lastSync ? new Date(lastSync) : null;

            this.fileCache = new Map();
            const keys = Object.keys(fileCache);
            for (const key of keys) {
                this.fileCache.set(key, fileCache[key]);
            }

            LogManager.log(LogLevel.Debug, `Cache loaded with ${this.fileCache.size} entries`);
            } catch (error) {
                throw new CacheError('read', `Failed to parse cache file: ${error.message}`);
            }
        } catch (error) {
            if (error instanceof CacheError) {
                throw error;
            }
            LogManager.log(LogLevel.Debug, 'Cache read failed, initializing empty cache', error);
            this.fileCache = new Map();
            this.lastSync = null;
        }
    }

    async writeCache(files: File[]): Promise<void> {
        const fileCache = files.reduce((cache, file) => {
            cache[file.name] = {
                md5: file.md5,
                utcTimestamp: file.lastModified.toISOString()
            };
            return cache;
        }, {} as { [key: string]: CacheEntry });

        const fileCacheJson = JSON.stringify({
            lastSync: this.lastSync,
            fileCache
        }, null, 2);

        try {
            if (!this.app.vault.adapter) {
                throw new CacheError('write', 'Vault adapter not available');
            }

            await this.ensureCacheDirectoryExists();
            const relativePath = this.getVaultRelativePath();

            try {
                await this.app.vault.adapter.writeBinary(
                    relativePath,
                    this.encoder.encode(fileCacheJson)
                );
                LogManager.log(LogLevel.Debug, `Cache updated with ${files.length} entries`);
            } catch (error) {
                throw new CacheError('write', `Failed to write cache file: ${error.message}`);
            }
        } catch (error) {
            if (error instanceof CacheError) {
                throw error;
            }
            throw new CacheError('write', `Unexpected error: ${error.message}`);
        }
    }

    getLastSync(): Date | null {
        return this.lastSync;
    }

    updateLastSync(): void {
        this.lastSync = new Date();
    }

    hasFile(fileName: string): boolean {
        return this.fileCache.has(fileName);
    }

    getMd5(fileName: string): string | undefined {
        const entry = this.fileCache.get(fileName);
        return entry?.md5;
    }

    getTimestamp(fileName: string): Date | undefined {
        const entry = this.fileCache.get(fileName);
        return entry ? new Date(entry.utcTimestamp) : undefined;
    }

    isFileUnchanged(fileName: string, md5: string, timestamp: Date): boolean {
        const entry = this.fileCache.get(fileName);
        if (!entry) return false;

        return entry.md5 === md5 &&
               entry.utcTimestamp === timestamp.toISOString();
    }
}
