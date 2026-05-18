import type { IStorageProvider, UploadUrlOptions, DownloadUrlOptions } from './storage.interface';

export class FakeStorageProvider implements IStorageProvider {
  public uploaded: Array<{ key: string; opts: UploadUrlOptions }> = [];
  public downloaded: Array<{ key: string; opts: DownloadUrlOptions }> = [];
  public deleted: string[] = [];

  async getUploadUrl(key: string, opts: UploadUrlOptions): Promise<string> {
    this.uploaded.push({ key, opts });
    return `https://fake-storage.test/upload/${key}?contentType=${opts.contentType}`;
  }

  async getDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string> {
    this.downloaded.push({ key, opts });
    return `https://fake-storage.test/download/${key}`;
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }

  async healthCheck(): Promise<void> {}

  reset(): void {
    this.uploaded = [];
    this.downloaded = [];
    this.deleted = [];
  }
}
