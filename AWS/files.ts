import { File } from '../sync/AbstractManager';
import { LogLevel } from '../sync/types';
import { LogManager } from '../LogManager';
import { AWSSigning } from './signing';
import { AWSPaths } from './paths';
import { encodeURIPath } from './encoding';
import { withRetry } from '../sync/utils/commonUtils';

interface S3RequestConfig {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    contentType?: string;
    body?: Uint8Array;
}

interface S3Response {
    status: number;
    headers: Record<string, string>;
    text: () => Promise<string>;
    arrayBuffer: () => Promise<ArrayBuffer>;
    ok: boolean;
}

export class AWSFiles {
    private static readonly DEFAULT_CONTENT_TYPE = 'application/octet-stream';
    private static readonly MAX_RETRIES = 3;
    private static readonly RETRY_OPTIONS = {
        maxAttempts: AWSFiles.MAX_RETRIES,
        delayMs: 1000,
        backoff: true,
        onRetry: (attempt: number, error: Error) => {
            LogManager.log(LogLevel.Debug, `Retrying S3 operation`, { attempt, error: error.message });
        }
    };

    constructor(
        private readonly bucket: string,
        private readonly endpoint: string,
        private readonly signing: AWSSigning,
        private readonly paths: AWSPaths
    ) {}

    private convertHeaders(headers: Headers): Record<string, string> {
        const result: Record<string, string> = {};
        headers.forEach((value, key) => {
            result[key] = value;
        });
        return result;
    }

    private async makeS3Request(config: S3RequestConfig): Promise<S3Response> {
        const { method, path, queryParams = {}, contentType = AWSFiles.DEFAULT_CONTENT_TYPE, body } = config;
        const host = new URL(this.endpoint).host;
        const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');

        const headers = await this.signing.signRequest({
            method,
            path,
            queryParams,
            host,
            amzdate,
            contentType,
            body
        });

        const url = this.buildS3Url(path, queryParams);
        LogManager.log(LogLevel.Debug, 'Making S3 request', { url, method });

        const requestInit: RequestInit = { method, headers };
        if (body) {
            requestInit.body = body;
            requestInit.headers = {
                ...headers,
                'Content-Length': body.length.toString()
            };
        }

        const response = await fetch(url, requestInit);
        return {
            status: response.status,
            headers: this.convertHeaders(response.headers),
            text: () => response.text(),
            arrayBuffer: () => response.arrayBuffer(),
            ok: response.ok
        };
    }

    private buildS3Url(path: string, queryParams: Record<string, string> = {}): string {
        const baseUrl = `${this.endpoint}${path}`;
        const params = new URLSearchParams(queryParams);
        const queryString = params.toString();
        return queryString ? `${baseUrl}?${queryString}` : baseUrl;
    }

    private async parseS3Error(response: S3Response): Promise<string> {
        try {
            const text = await response.text();
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(text, "text/xml");
            const errorElement = xmlDoc.getElementsByTagName('Error')[0];

            if (errorElement) {
                const code = errorElement.getElementsByTagName('Code')[0]?.textContent ?? 'UnknownError';
                const message = errorElement.getElementsByTagName('Message')[0]?.textContent ?? 'Unknown error occurred';
                return `${code}: ${message}`;
            }
        } catch (error) {
            LogManager.log(LogLevel.Debug, 'Failed to parse S3 error response', error);
        }
        return `HTTP error! status: ${response.status}`;
    }

    private async handleS3Response(response: S3Response, operation: string): Promise<S3Response> {
        if (!response.ok) {
            const errorMessage = await this.parseS3Error(response);
            throw new Error(`S3 ${operation} failed: ${errorMessage}`);
        }
        return response;
    }

    async readFile(file: File): Promise<Uint8Array> {
        return withRetry(async () => {
            const remotePath = this.paths.addVaultPrefix(file.remoteName || this.paths.localToRemoteName(file.name));
            const encodedPath = encodeURIPath(remotePath);

            LogManager.log(LogLevel.Trace, `Reading ${file.name} from S3`);

            const response = await this.makeS3Request({
                method: 'GET',
                path: `/${this.bucket}/${encodedPath}`
            });

            await this.handleS3Response(response, 'read');
            const buffer = new Uint8Array(await response.arrayBuffer());

            LogManager.log(LogLevel.Trace, `Read ${buffer.length} bytes from ${file.name}`);
            return buffer;
        }, AWSFiles.RETRY_OPTIONS);
    }

    async writeFile(file: File, content: Uint8Array): Promise<void> {
        return withRetry(async () => {
            const remotePath = this.paths.addVaultPrefix(file.remoteName || this.paths.localToRemoteName(file.name));
            const encodedPath = encodeURIPath(remotePath);

            LogManager.log(LogLevel.Trace, `Writing ${file.name} to S3 (${content.length} bytes)`);

            const response = await this.makeS3Request({
                method: 'PUT',
                path: `/${this.bucket}/${encodedPath}`,
                body: content
            });

            await this.handleS3Response(response, 'write');
            LogManager.log(LogLevel.Trace, `Successfully wrote ${file.name} to S3`);
        }, AWSFiles.RETRY_OPTIONS);
    }

    async deleteFile(file: File): Promise<void> {
        return withRetry(async () => {
            const remotePath = this.paths.addVaultPrefix(file.remoteName || this.paths.localToRemoteName(file.name));
            const encodedPath = encodeURIPath(remotePath);

            LogManager.log(LogLevel.Trace, `Deleting ${file.name} from S3`);

            const response = await this.makeS3Request({
                method: 'DELETE',
                path: `/${this.bucket}/${encodedPath}`
            });

            if (response.status !== 204 && !response.ok) {
                await this.handleS3Response(response, 'delete');
            }

            LogManager.log(LogLevel.Trace, `Successfully deleted ${file.name} from S3`);
        }, AWSFiles.RETRY_OPTIONS);
    }

    async getFiles(vaultPrefix: string): Promise<File[]> {
        return withRetry(async () => {
            LogManager.log(LogLevel.Trace, 'Listing files in S3 bucket');

            const response = await this.makeS3Request({
                method: 'GET',
                path: `/${this.bucket}`,
                queryParams: {
                    'list-type': '2',
                    'prefix': `${vaultPrefix}/`
                },
                contentType: 'application/xml'
            });

            await this.handleS3Response(response, 'list');
            return this.parseFileList(await response.text());
        }, AWSFiles.RETRY_OPTIONS);
    }

    private parseFileList(xmlText: string): File[] {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        const contents = xmlDoc.getElementsByTagName('Contents');

        if (!contents || contents.length === 0) {
            LogManager.log(LogLevel.Debug, 'No files found in S3 bucket');
            return [];
        }

        const files = Array.from(contents).map(item => {
            const key = item.getElementsByTagName('Key')[0]?.textContent ?? '';
            const lastModified = new Date(item.getElementsByTagName('LastModified')[0]?.textContent ?? '');
            const eTag = (item.getElementsByTagName('ETag')[0]?.textContent ?? '').replace(/"/g, '');
            const size = Number(item.getElementsByTagName('Size')[0]?.textContent ?? '0');

            const nameWithoutPrefix = this.paths.removeVaultPrefix(key);
            const localName = this.paths.remoteToLocalName(nameWithoutPrefix);

            return {
                name: localName,
                localName,
                remoteName: key,
                mime: AWSFiles.DEFAULT_CONTENT_TYPE,
                lastModified,
                size,
                md5: eTag,
                isDirectory: false
            };
        });

        LogManager.log(LogLevel.Trace, `Found ${files.length} files in S3 bucket`);
        return files;
    }
}
