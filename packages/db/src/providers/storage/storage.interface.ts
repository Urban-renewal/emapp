export interface UploadUrlOptions {
  contentType: string;
  maxSizeBytes: number;
  ttlSeconds: number;
}

export interface DownloadUrlOptions {
  ttlSeconds: number;
  responseFilename?: string;
}

export interface IStorageProvider {
  getUploadUrl(key: string, opts: UploadUrlOptions): Promise<string>;
  getDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string>;
  delete(key: string): Promise<void>;
  healthCheck(): Promise<void>;
}
