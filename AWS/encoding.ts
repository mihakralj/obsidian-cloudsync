const URI_REPLACEMENTS = new Map([
    ['~', '%7E'],
    ["'", '%27'],
    ['(', '%28'],
    [')', '%29'],
    ['!', '%21'],
    ['*', '%2A'],
    ['?', '%3F'],
    ['+', '%20'],
    ['%20', '%20']
]);

const DECODE_REPLACEMENTS = new Map([
    ['%20', ' '],
    ['%21', '!'],
    ['%27', "'"],
    ['%28', '('],
    ['%29', ')'],
    ['%2A', '*'],
    ['%3F', '?'],
    ['%7E', '~']
]);

function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function encodeURIPath(uri: string): string {
    const decodedUri = (() => {
        try {
            return decodeURIComponent(uri);
        } catch {
            return uri;
        }
    })();

    return decodedUri.split('/').map(segment => {
        if (!segment) return '';

        const encoded = encodeURIComponent(segment);
        return Array.from(URI_REPLACEMENTS.entries()).reduce(
            (result, [char, replacement]) =>
                result.replace(new RegExp(escapeRegExp(char), 'g'), replacement),
            encoded
        );
    }).join('/');
}

export function decodeURIPath(remotePath: string): string {
    try {
        const decoded = Array.from(DECODE_REPLACEMENTS.entries()).reduce(
            (result, [encoded, char]) =>
                result.replace(new RegExp(escapeRegExp(encoded), 'g'), char),
            remotePath
        );
        return decodeURIComponent(decoded);
    } catch {
        return remotePath;
    }
}
