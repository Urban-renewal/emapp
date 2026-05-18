export interface IEncryptionService {
  hash(plaintext: string): string;
  healthCheck(): Promise<void>;
}
