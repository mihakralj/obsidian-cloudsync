export class CloudSyncError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CloudSyncError';
    }
}

export class AuthenticationError extends CloudSyncError {
    constructor(provider: string, details?: string) {
        super(`Authentication failed for ${provider}${details ? `: ${details}` : ''}`);
        this.name = 'AuthenticationError';
    }
}

export class ConnectivityError extends CloudSyncError {
    constructor(provider: string, details?: string) {
        super(`Connection failed to ${provider}${details ? `: ${details}` : ''}`);
        this.name = 'ConnectivityError';
    }
}

export class SyncError extends CloudSyncError {
    constructor(operation: string, details?: string) {
        super(`Sync operation failed during ${operation}${details ? `: ${details}` : ''}`);
        this.name = 'SyncError';
    }
}

export class FileOperationError extends CloudSyncError {
    constructor(operation: 'read' | 'write' | 'delete', path: string, details?: string) {
        super(`File ${operation} failed for ${path}${details ? `: ${details}` : ''}`);
        this.name = 'FileOperationError';
    }
}

export class ConfigurationError extends CloudSyncError {
    constructor(setting: string, details?: string) {
        super(`Invalid configuration for ${setting}${details ? `: ${details}` : ''}`);
        this.name = 'ConfigurationError';
    }
}

export class CacheError extends CloudSyncError {
    constructor(operation: string, details?: string) {
        super(`Cache operation failed during ${operation}${details ? `: ${details}` : ''}`);
        this.name = 'CacheError';
    }
}
