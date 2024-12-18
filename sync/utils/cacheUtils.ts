import { CacheManager } from "../CacheManager";
import { LogManager } from "../../LogManager";
import { LogLevel } from "../types";
import { CacheError } from "../errors";
import { ResourceManager } from "./timeoutUtils";
import { App, normalizePath } from "obsidian";
import { dirname } from "path-browserify";

const CACHE_CLEANUP_INTERVAL = 1000 * 60 * 60; // 1 hour
const CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 7; // 7 days

export class CacheManagerService {
    private static instance: CacheManagerService;
    private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    private activeCaches: Map<string, CacheManager> = new Map();

    private constructor() {
        this.startCleanupTimer();
        ResourceManager.registerCleanup(() => this.cleanup());
    }

    static getInstance(): CacheManagerService {
        if (!this.instance) {
            this.instance = new CacheManagerService();
        }
        return this.instance;
    }

    private startCleanupTimer(): void {
        this.cleanupTimer = setInterval(() => {
            this.cleanupOldCaches().catch(error => {
                LogManager.log(LogLevel.Error, 'Cache cleanup failed', error);
            });
        }, CACHE_CLEANUP_INTERVAL);

        ResourceManager.registerTimer(this.cleanupTimer);
    }

    async getCache(path: string, app: App): Promise<CacheManager> {
        try {
            const normalizedPath = normalizePath(path);

            if (!this.activeCaches.has(normalizedPath)) {
                const cache = CacheManager.getInstance(normalizedPath, app);
                await cache.readCache();
                this.activeCaches.set(normalizedPath, cache);
            }

            return this.activeCaches.get(normalizedPath)!;
        } catch (error) {
            throw new CacheError('cache initialization', `Failed to initialize cache at ${path}: ${error.message}`);
        }
    }

    async invalidateCache(path: string): Promise<void> {
        const normalizedPath = normalizePath(path);
        const cache = this.activeCaches.get(normalizedPath);

        if (cache) {
            try {
                // Write empty cache
                await cache.writeCache([]);
                this.activeCaches.delete(normalizedPath);
                LogManager.log(LogLevel.Debug, `Cache invalidated: ${normalizedPath}`);
            } catch (error) {
                throw new CacheError('cache invalidation', `Failed to invalidate cache at ${path}: ${error.message}`);
            }
        }
    }

    private async cleanupOldCaches(): Promise<void> {
        const now = Date.now();
        const promises: Promise<void>[] = [];

        for (const [path, cache] of this.activeCaches) {
            const lastSync = cache.getLastSync();
            if (lastSync && (now - lastSync.getTime() > CACHE_MAX_AGE)) {
                promises.push(this.invalidateCache(path));
            }
        }

        await Promise.all(promises);
    }

    async cleanup(): Promise<void> {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        const promises = Array.from(this.activeCaches.keys()).map(path =>
            this.invalidateCache(path)
        );

        await Promise.all(promises);
        this.activeCaches.clear();
    }

    async ensureCacheDirectory(path: string, app: App): Promise<void> {
        const normalizedPath = normalizePath(path);
        const dirPath = dirname(normalizedPath);

        if (dirPath === '.') return;

        try {
            const exists = await app.vault.adapter.exists(dirPath);
            if (!exists) {
                LogManager.log(LogLevel.Debug, `Creating cache directory: ${dirPath}`);
                await app.vault.adapter.mkdir(dirPath);
            }
        } catch (error) {
            throw new CacheError('directory creation', `Failed to create cache directory ${dirPath}: ${error.message}`);
        }
    }
}
