import { LogManager } from "../../LogManager";
import { LogLevel } from "../types";
import { App } from "obsidian";

export interface RetryOptions {
    maxAttempts?: number;
    delayMs?: number;
    backoff?: boolean;
    onRetry?: (attempt: number, error: Error) => void;
}

export interface ValidationResult {
    isValid: boolean;
    errors: string[];
}

export class ValidationError extends Error {
    constructor(public errors: string[]) {
        super(errors.join(', '));
        this.name = 'ValidationError';
    }
}

export function validateNotEmpty(value: string | undefined, fieldName: string): string {
    if (!value || value.trim().length === 0) {
        throw new ValidationError([`${fieldName} cannot be empty`]);
    }
    return value.trim();
}

export function validatePattern(value: string, pattern: RegExp, fieldName: string): string {
    if (!pattern.test(value)) {
        throw new ValidationError([`${fieldName} has invalid format`]);
    }
    return value;
}

export async function withRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const {
        maxAttempts = 3,
        delayMs = 1000,
        backoff = true,
        onRetry = (attempt: number, error: Error) => {
            LogManager.log(
                LogLevel.Debug,
                `Retry attempt ${attempt} after error: ${error.message}`
            );
        }
    } = options;

    let lastError: Error;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error as Error;

            if (attempt < maxAttempts) {
                onRetry(attempt, lastError);
                const delay = backoff ? delayMs * attempt : delayMs;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError!;
}

export function memoize<T>(
    fn: (...args: any[]) => T,
    keyFn: (...args: any[]) => string = (...args) => JSON.stringify(args)
): (...args: any[]) => T {
    const cache = new Map<string, { value: T; timestamp: number }>();
    const TTL = 5 * 60 * 1000; // 5 minutes

    return (...args: any[]): T => {
        const key = keyFn(...args);
        const cached = cache.get(key);
        const now = Date.now();

        if (cached && now - cached.timestamp < TTL) {
            return cached.value;
        }

        const result = fn(...args);
        cache.set(key, { value: result, timestamp: now });
        return result;
    };
}

export function safeParseJSON<T>(json: string, defaultValue: T): T {
    try {
        return JSON.parse(json) as T;
    } catch {
        return defaultValue;
    }
}

export async function ensureDirectoryExists(app: App, path: string): Promise<void> {
    try {
        const exists = await app.vault.adapter.exists(path);
        if (!exists) {
            await app.vault.adapter.mkdir(path);
            LogManager.log(LogLevel.Debug, `Created directory: ${path}`);
        }
    } catch (error) {
        LogManager.log(LogLevel.Error, `Failed to create directory: ${path}`, error);
        throw error;
    }
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}

export function createDeferred<T>() {
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject: (reason?: any) => void;

    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return {
        promise,
        resolve: resolve!,
        reject: reject!
    };
}

export function throttle<T extends (...args: any[]) => any>(
    func: T,
    limit: number
): (...args: Parameters<T>) => void {
    let inThrottle = false;

    return function(this: any, ...args: Parameters<T>): void {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => {
                inThrottle = false;
            }, limit);
        }
    };
}

export function deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (obj instanceof Date) {
        return new Date(obj.getTime()) as any;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => deepClone(item)) as any;
    }

    const cloned = {} as T;
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            cloned[key] = deepClone(obj[key]);
        }
    }
    return cloned;
}
