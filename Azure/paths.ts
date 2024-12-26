import { normalizePath } from 'obsidian';
import { encodeCloudPath } from '../sync/pathEncoding';
import { LogManager } from '../LogManager';
import { LogLevel } from '../sync/types';

export class AzurePaths {
    constructor(private readonly containerName: string) {}

    normalizeCloudPath(path: string): string {
        // Just normalize path separators, don't decode
        return normalizePath(path);
    }

    getBlobUrl(account: string, blobName: string, sasToken: string): string {
        const token = sasToken.startsWith('?') ? sasToken.substring(1) : sasToken;
        // Encode container name and blobName for URL
        const encodedContainer = encodeCloudPath(this.containerName);
        const encodedBlobName = encodeURIComponent(blobName);
        const url = `https://${account}.blob.core.windows.net/${encodedContainer}/${encodedBlobName}?${token}`;
        LogManager.log(LogLevel.Trace, `Generated Azure URL for blob: ${blobName} -> ${url}`);
        return url;
    }

    getContainerUrl(account: string, sasToken: string, operation?: string): string {
        const encodedContainer = encodeCloudPath(this.containerName);
        const baseUrl = `https://${account}.blob.core.windows.net/${encodedContainer}?restype=container`;
        const parts = [];

        if (operation === 'list') {
            parts.push('comp=list');
        }

        if (sasToken) {
            const token = sasToken.startsWith('?') ? sasToken.substring(1) : sasToken;
            parts.push(token);
        }

        return parts.length > 0 ? baseUrl + '&' + parts.join('&') : baseUrl;
    }

    encodePathProperly(path: string): string {
        // First normalize the path
        const normalized = normalizePath(path);
        // Then encode using our cloud path encoding
        return encodeCloudPath(normalized);
    }

    decodePathProperly(path: string): string {
        // Don't decode paths from Azure - they are literal filenames
        return path;
    }
}
