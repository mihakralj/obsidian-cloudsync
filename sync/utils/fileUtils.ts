import { File } from "../AbstractManager";
import { LogManager } from "../../LogManager";
import { LogLevel } from "../types";
import { FileOperationError } from "../errors";
import { withTimeout } from "./timeoutUtils";
import { normalizePath } from "obsidian";

const FILE_OPERATION_TIMEOUT = 30000; // 30 seconds

export interface FileOperationResult {
    success: boolean;
    error?: string;
    file?: File;
}

export class FileOperationService {
    static async readFile(
        source: { readFile: (file: File) => Promise<Uint8Array> },
        file: File
    ): Promise<Uint8Array> {
        try {
            return await withTimeout(
                source.readFile(file),
                FILE_OPERATION_TIMEOUT,
                `read ${file.name}`
            );
        } catch (error) {
            throw new FileOperationError('read', file.name, error.message);
        }
    }

    static async writeFile(
        target: { writeFile: (file: File, content: Uint8Array) => Promise<void> },
        file: File,
        content: Uint8Array
    ): Promise<void> {
        try {
            await withTimeout(
                target.writeFile(file, content),
                FILE_OPERATION_TIMEOUT,
                `write ${file.name}`
            );
        } catch (error) {
            throw new FileOperationError('write', file.name, error.message);
        }
    }

    static async deleteFile(
        target: { deleteFile: (file: File) => Promise<void> },
        file: File
    ): Promise<void> {
        try {
            await withTimeout(
                target.deleteFile(file),
                FILE_OPERATION_TIMEOUT,
                `delete ${file.name}`
            );
        } catch (error) {
            throw new FileOperationError('delete', file.name, error.message);
        }
    }

    static async copyFile(
        source: { readFile: (file: File) => Promise<Uint8Array> },
        target: { writeFile: (file: File, content: Uint8Array) => Promise<void> },
        file: File,
        isLocalToRemote: boolean
    ): Promise<void> {
        const operation = isLocalToRemote ? 'upload' : 'download';
        LogManager.log(LogLevel.Debug, `Starting ${operation} of ${file.name}`);

        try {
            const content = await this.readFile(source, file);

            if (!isLocalToRemote) {
                file.localName = normalizePath(file.name);
            }

            await this.writeFile(target, file, content);
            LogManager.log(LogLevel.Trace, `Completed ${operation} of ${file.name}`);
        } catch (error) {
            LogManager.log(LogLevel.Error, `Failed to ${operation} ${file.name}`, error);
            throw error;
        }
    }

    static async verifyFileOperation(
        operation: 'read' | 'write' | 'delete',
        target: { readFile?: (file: File) => Promise<Uint8Array> },
        file: File
    ): Promise<FileOperationResult> {
        try {
            if (operation === 'delete') {
                return { success: true };
            }

            if (operation === 'read' && target.readFile) {
                await target.readFile(file);
                return { success: true, file };
            }

            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    static async retryOperation<T>(
        operation: () => Promise<T>,
        maxRetries: number = 3,
        delayMs: number = 1000
    ): Promise<T> {
        let lastError: Error;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
                }
            }
        }

        throw lastError!;
    }
}
