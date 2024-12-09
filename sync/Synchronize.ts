import { AbstractManager } from "./AbstractManager";
import { LogManager } from "../LogManager";
import { LogLevel } from "./types";
import { Scenario } from "./types/sync";
import { FileOperations } from "./FileOperations";
import { CacheManager } from "./CacheManager";
import { SyncAnalyzer } from "./SyncAnalyzer";
import { SyncExecutor } from "./SyncExecutor";

export class Synchronize {
    private readonly fileOps: FileOperations;
    private readonly cache: CacheManager;
    private readonly analyzer: SyncAnalyzer;
    private readonly executor: SyncExecutor;

    constructor(local: AbstractManager, remote: AbstractManager, cacheFilePath: string) {
        this.fileOps = new FileOperations(local, remote);
        this.cache = new CacheManager(cacheFilePath);
        this.analyzer = new SyncAnalyzer(local, remote, this.cache);
        this.executor = new SyncExecutor(local, remote, this.fileOps, this.cache);

        const vaultName = (local as any).getVaultName?.() || 'default';
        LogManager.log(LogLevel.Debug, 'Synchronize initialized', {
            vault: vaultName,
            provider: remote.name,
            cacheFile: cacheFilePath
        });
    }

    async syncActions(): Promise<Scenario[]> {
        await this.cache.readCache();
        return this.analyzer.analyze();
    }

    async runAllScenarios(scenarios: Scenario[]): Promise<void> {
        await this.executor.execute(scenarios);
    }
}