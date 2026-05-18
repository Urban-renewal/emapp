// DB package public API
// Direct db/pool access is internal only — all external reads go through withTenant / withProvider
export { pool, db, providerDb, type Database, type ProviderDatabase } from './client';
export { env } from './env';
export { withTenant, type TenantTx } from './wrappers/with-tenant';
export { withProvider } from './wrappers/with-provider';
export { withBootstrap } from './wrappers/with-bootstrap';
export { verifyEncryptionStartup } from './startup-check';
export * from './schema/index';
export { sql } from 'drizzle-orm';
export { AuditService } from './audit/audit.service';
export type { AuditEntry } from './audit/audit.service';
export * from './helpers/share-defaults';
export * from './helpers/apply-share-permissions';
export * from './helpers/resolve-share';
export * from './helpers/notifications';
export * from './helpers/idempotency';
export * from './helpers/members';
export * from './helpers/documents';
export {
  encryptOwnerPii,
  decryptOwnerPii,
  hashField,
  encryptField,
  decryptField,
} from './helpers/owners';
export type { IEncryptionService } from './providers/encryption/encryption.interface';
export { PgcryptoEncryptionService } from './providers/encryption/pgcrypto.provider';
export { FakeEncryptionService } from './providers/encryption/fake.provider';
export type {
  IEmailProvider,
  EmailMessage,
  EmailDeliveryResult,
} from './providers/email/email.interface';
export { ResendEmailProvider } from './providers/email/resend.provider';
export { FakeEmailProvider } from './providers/email/fake.provider';
export type { ISMSProvider, SMSDeliveryResult } from './providers/sms/sms.interface';
export { NoopSMSProvider } from './providers/sms/noop.provider';
export { FakeSMSProvider } from './providers/sms/fake.provider';
export type {
  IStorageProvider,
  UploadUrlOptions,
  DownloadUrlOptions,
} from './providers/storage/storage.interface';
export { R2StorageProvider } from './providers/storage/r2.provider';
export { FakeStorageProvider } from './providers/storage/fake.provider';
export type { ICacheProvider } from './providers/cache/cache.interface';
export { PostgresCacheProvider } from './providers/cache/postgres.provider';
export { FakeCacheProvider } from './providers/cache/fake.provider';
export type { IRealtimeProvider, RealtimeEvent } from './providers/realtime/realtime.interface';
export { SseRealtimeProvider } from './providers/realtime/sse.provider';
export { FakeRealtimeProvider } from './providers/realtime/fake.provider';
