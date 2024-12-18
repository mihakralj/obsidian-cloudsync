export interface AzureSettings {
    account: string;
    accessKey: string;
}

export interface AWSSettings {
    accessKey: string;
    secretKey: string;
    bucket: string;
    region: string;
}

export interface GCPSettings {
    privateKey: string;
    clientEmail: string;
    bucket: string;
}

export interface CloudProviderSettings extends Partial<AzureSettings & AWSSettings & GCPSettings> {
    [key: string]: string | undefined;
}

export enum LogLevel {
    None = "None",
    Error = "Error",
    Info = "Info",
    Trace = "Trace",
    Debug = "Debug"
}

export interface CloudSyncSettings {
    azureEnabled: boolean;
    awsEnabled: boolean;
    gcpEnabled: boolean;
    logLevel: LogLevel;
    azure: AzureSettings;
    aws: AWSSettings;
    gcp: GCPSettings;
    syncIgnore: string;
    autoSyncDelay: number;
    saveSettings?: () => Promise<void>;
}

export const DEFAULT_SETTINGS: CloudSyncSettings = {
    azureEnabled: false,
    awsEnabled: false,
    gcpEnabled: false,
    logLevel: LogLevel.Info,
    azure: {
        account: "",
        accessKey: "",
    } as AzureSettings,
    aws: {
        accessKey: "",
        secretKey: "",
        bucket: "",
        region: "us-east-1",
    } as AWSSettings,
    gcp: {
        privateKey: "",
        clientEmail: "",
        bucket: "",
    } as GCPSettings,
    syncIgnore: "",
    autoSyncDelay: 0
}
