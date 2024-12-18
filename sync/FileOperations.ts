import { AbstractManager, File } from "./AbstractManager";
import { LogManager } from "../LogManager";
import { LogLevel } from "./types";
import { LocalManager } from "./localManager";
import { normalizePath } from "obsidian";
import { FileOperationError } from "./errors";

export class FileOperations {
    constructor(
        private readonly local: AbstractManager,
        private readonly remote: AbstractManager
    ) {}

    async copyToRemote(file: File): Promise<void> {
        LogManager.log(LogLevel.Debug, `Preparing to upload ${file.name} to ${this.remote.name}`);
        try {
            const content = await this.local.readFile(file).catch(error => {
                throw new FileOperationError('read', file.name, `Local read failed: ${error.message}`);
            });

            await this.remote.writeFile(file, content).catch(error => {
                throw new FileOperationError('write', file.name, `Remote write failed: ${error.message}`);
            });

            LogManager.log(LogLevel.Trace, `Uploaded ${file.name} to ${this.remote.name}`);
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to upload ${file.name} to ${this.remote.name}`, error);
            throw error;
        }
    }

    async copyToLocal(file: File): Promise<void> {
        LogManager.log(LogLevel.Debug, `Preparing to download ${file.name} from ${this.remote.name}`);
        try {
            const content = await this.remote.readFile(file).catch(error => {
                throw new FileOperationError('read', file.name, `Remote read failed: ${error.message}`);
            });

            file.localName = normalizePath(file.name);
            await this.local.writeFile(file, content).catch(error => {
                throw new FileOperationError('write', file.name, `Local write failed: ${error.message}`);
            });

            LogManager.log(LogLevel.Trace, `Downloaded ${file.name} from ${this.remote.name}`);
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to download ${file.name} from ${this.remote.name}`, error);
            throw error;
        }
    }

    async deleteFromRemote(file: File): Promise<void> {
        LogManager.log(LogLevel.Debug, `Preparing to delete ${file.name} from ${this.remote.name}`);
        try {
            await this.remote.deleteFile(file).catch(error => {
                throw new FileOperationError('delete', file.name, `Remote delete failed: ${error.message}`);
            });
            LogManager.log(LogLevel.Trace, `Deleted ${file.name} from ${this.remote.name}`);
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to delete ${file.name} from ${this.remote.name}`, error);
            throw error;
        }
    }

    async deleteFromLocal(file: File): Promise<void> {
        LogManager.log(LogLevel.Debug, `Preparing to delete ${file.name} from local`);
        try {
            file.localName = normalizePath(file.name);
            await this.local.deleteFile(file).catch(error => {
                throw new FileOperationError('delete', file.name, `Local delete failed: ${error.message}`);
            });
            LogManager.log(LogLevel.Trace, `Deleted ${file.name} from local`);
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to delete ${file.name} from local`, error);
            throw error;
        }
    }
}
