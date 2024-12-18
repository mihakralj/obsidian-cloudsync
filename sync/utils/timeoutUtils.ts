export class TimeoutError extends Error {
    constructor(operation: string, timeoutMs: number) {
        super(`Operation '${operation}' timed out after ${timeoutMs}ms`);
        this.name = 'TimeoutError';
    }
}

export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string
): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new TimeoutError(operation, timeoutMs));
        }, timeoutMs);
    });

    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutHandle!);
        return result;
    } catch (error) {
        clearTimeout(timeoutHandle!);
        throw error;
    }
}

export function debounce<T extends (...args: any[]) => any>(
    func: T,
    waitMs: number
): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    return function executedFunction(...args: Parameters<T>) {
        if (timeout) {
            clearTimeout(timeout);
        }

        timeout = setTimeout(() => {
            func(...args);
            timeout = null;
        }, waitMs);
    };
}

export class ResourceManager {
    private static timers: Set<ReturnType<typeof setTimeout>> = new Set();
    private static cleanupCallbacks: Set<() => Promise<void>> = new Set();

    static registerTimer(timer: ReturnType<typeof setTimeout>): void {
        this.timers.add(timer);
    }

    static clearTimer(timer: ReturnType<typeof setTimeout>): void {
        if (this.timers.has(timer)) {
            clearTimeout(timer);
            this.timers.delete(timer);
        }
    }

    static registerCleanup(callback: () => Promise<void>): void {
        this.cleanupCallbacks.add(callback);
    }

    static async cleanup(): Promise<void> {
        // Clear all timers
        this.timers.forEach(timer => {
            clearTimeout(timer);
        });
        this.timers.clear();

        // Execute all cleanup callbacks
        const cleanupPromises = Array.from(this.cleanupCallbacks).map(callback => {
            try {
                return callback();
            } catch (error) {
                console.error('Cleanup callback failed:', error);
                return Promise.resolve();
            }
        });

        await Promise.all(cleanupPromises);
        this.cleanupCallbacks.clear();
    }
}
