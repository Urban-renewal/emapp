// DB package public API
// Direct db/pool access is internal only — all external reads go through withTenant / withProvider
export {
  pool,
  db,
  providerDb,
  closeAllPools,
  setPoolErrorObserver,
  // D.37 / Phase 6.5 — system-health surface (read-only telemetry).
  getPoolStats,
  setStorageErrorObserver,
  recordStorageError,
  getStorageErrorStats,
  // Test-only seam — production code MUST NOT call this; the system-
  // health counter is per-process by design (resets only on restart).
  resetStorageErrorStatsForTests,
  type Database,
  type ProviderDatabase,
  type PoolErrorEvent,
  type PoolErrorObserver,
  type PoolErrorSource,
  type PoolName,
  type PoolStatsSnapshot,
  type AllPoolsStats,
  type StorageErrorEvent,
  type StorageErrorObserver,
  type StorageErrorStats,
} from './client';
export { env, reloadEnv } from './env';
export {
  resolveDbTarget,
  isDbTarget,
  DB_TARGETS,
  DEFAULT_DB_TARGET,
  type DbTarget,
  type ResolvedDbTarget,
  type DbTargetEnv,
} from './db-target';
export { withTenant, type TenantTx } from './wrappers/with-tenant';
export { withProvider } from './wrappers/with-provider';
export { withBootstrap } from './wrappers/with-bootstrap';
export { verifyEncryptionStartup, verifyProviderPoolRole } from './startup-check';
// Audit v1.1 closures — pure validators for Provider tier inputs
// (access_reason quality + action regex + metadata size + UUID). One
// source of truth for both the HTTP decorator AND the withProvider
// wrapper (SA-13 deduplication; CC-2 quality rule; CC-3 SRP extract).
export {
  validateProviderAction,
  validateProviderMetadata,
  validateProviderReason,
  validateProviderUserId,
  PROVIDER_ACTION_MAX_LEN,
  PROVIDER_ACTION_REGEX,
  PROVIDER_CONTROL_CHARS_REGEX,
  PROVIDER_METADATA_MAX_BYTES,
  PROVIDER_REASON_MAX_LEN,
  PROVIDER_REASON_MIN_LEN,
  PROVIDER_TICKET_REF_REGEX,
  PROVIDER_UUID_REGEX,
  type ReasonFailureCode,
  type ActionFailureCode,
  type MetadataFailureCode,
  type ValidatorOk,
  type ValidatorFailed,
  type ValidatorResult,
} from './helpers/provider-validators';
export * from './schema/index';
export { sql } from 'drizzle-orm';
export { AuditService } from './audit/audit.service';
export type { AuditEntry } from './audit/audit.service';
export { STATS_EPOCH_TTL_SECONDS, statsEpochKey, bumpStatsEpoch } from './helpers/stats-epoch';
export * from './helpers/share-defaults';
export * from './helpers/apply-share-permissions';
export * from './helpers/resolve-share';
export * from './helpers/signature-progress';
export * from './helpers/reap-expired-rows';
export * from './helpers/audit-retention';
export * from './helpers/signature-expiry-sweep';
export * from './helpers/proposals';
export * from './helpers/proposal-producer';
export * from './helpers/recommenders/missing-required-doc.detect';
// Autonomous Managing System, wave 1.1 — the PII-FREE, set-based ProjectPerception
// assembler (composes the canonical signature/consent/missing-doc/terminal seams).
export * from './helpers/perception/project-lifecycle.detect';
export * from './helpers/recommenders/signature-reissue.recommender';
export * from './helpers/recommenders/reminder-cadence.recommender';
export * from './helpers/recommenders/task-watcher.recommender';
export * from './helpers/recommenders/document-chase.recommender';
// Autonomous Managing System, wave 1.3 — perception-driven, PROPOSE-ONLY signature
// recommenders (stalled-collection reminder + expiring-soon reissue) reading the
// canonical signature-activity projection of the ProjectPerception read-model.
export * from './helpers/recommenders/signature-activity.detect';
export * from './helpers/recommenders/signature-stalled.recommender';
export * from './helpers/recommenders/signature-expiring.recommender';
// Slice 2.7 — apartment blocking-state (deceased/dispute/eviction) on a gathering-
// signatures project → propose a task.create (NO new autonomy kind). PII-free.
export * from './helpers/recommenders/apartment-blocker.recommender';
export * from './helpers/outbound-governor';
export * from './helpers/org-suspension';
export * from './helpers/notifications';
export * from './helpers/idempotency';
export * from './helpers/members';
export * from './helpers/documents';
export {
  encryptOwnerPii,
  encryptOwnerPiiBatch,
  decryptOwnerPii,
  decryptOwnerPiiBatch,
  decryptOwnerNamesBatch,
  encryptOwnerName,
  decryptOwnerName,
  hashOwnerName,
  buildErasureTombstone,
  ERASURE_TOMBSTONE_PLAINTEXT,
  SIGNATURE_BLOB_TOMBSTONE,
  hashField,
  encryptField,
  decryptField,
  type EncryptedOwnerRow,
  type DecryptedOwnerRow,
  type EncryptedOwnerNameRow,
} from './helpers/owners';
export {
  purgeImportBytes,
  type PurgeImportBytesOpts,
  type PurgeLogger,
} from './helpers/import-bytes';
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
export { buildEmailFrom, DEFAULT_EMAIL_FROM } from './providers/email/email-from';
export type { ISMSProvider, SMSDeliveryResult } from './providers/sms/sms.interface';
export { NoopSMSProvider } from './providers/sms/noop.provider';
export { FakeSMSProvider } from './providers/sms/fake.provider';
export { InforuSmsProvider, toInternational } from './providers/sms/inforu.provider';
export type { InforuSmsConfig } from './providers/sms/inforu.provider';
export type {
  IExtractionProvider,
  ExtractionInput,
  ExtractionResult,
  ExtractionRow,
} from './providers/extraction/extraction.interface';
export { StubExtractionProvider } from './providers/extraction/stub.provider';
// P3b — pluggable parcel-data provider (zero-egress Stub default; LocalMapi
// reads the bulk-מפ"י-loaded parcel_lookup reference table, migration 0074).
export type {
  IParcelDataProvider,
  ParcelLookupQuery,
  ParcelLookupResult,
} from './providers/parcel/parcel.interface';
export { StubParcelDataProvider } from './providers/parcel/stub.provider';
export { LocalMapiParcelDataProvider } from './providers/parcel/local-mapi.provider';
export type {
  IStorageProvider,
  UploadUrlOptions,
  DownloadUrlOptions,
  StorageObjectMeta,
} from './providers/storage/storage.interface';
export { R2StorageProvider } from './providers/storage/r2.provider';
export {
  buildR2Provider,
  r2EnvIsComplete,
  type R2EnvVars,
  type R2SdkDeps,
  type R2ClientTuning,
} from './providers/storage/r2-factory';
export {
  FakeStorageProvider,
  STORAGE_NOT_CONFIGURED_MESSAGE,
  type FakeStorageProviderOptions,
} from './providers/storage/fake.provider';
export { MINIMAL_PDF, buildMinimalPdf } from './fixtures/minimal-pdf';
export type { ICacheProvider } from './providers/cache/cache.interface';
export { PostgresCacheProvider } from './providers/cache/postgres.provider';
export { FakeCacheProvider } from './providers/cache/fake.provider';
export type { IRealtimeProvider, RealtimeEvent } from './providers/realtime/realtime.interface';
export { SseRealtimeProvider } from './providers/realtime/sse.provider';
export { FakeRealtimeProvider } from './providers/realtime/fake.provider';
// P0.B1 — pluggable file anti-malware scan provider.
export type {
  IFileScanProvider,
  ScanInput,
  ScanResult,
  ScanVerdict,
} from './providers/scan/scan.interface';
export { resolveScanBytes } from './providers/scan/scan.interface';
export { NoopFileScanProvider } from './providers/scan/noop.provider';
export {
  ClamAvFileScanProvider,
  buildInstream,
  parseReply,
  type ClamAvScanConfig,
} from './providers/scan/clamav.provider';
// P0.B2 — pluggable observability + breach-detection seam.
export type { IMetricsProvider, MetricLabels } from './providers/metrics/metrics.interface';
export { NoopMetricsProvider } from './providers/metrics/noop.provider';
export { PrometheusMetricsProvider } from './providers/metrics/prometheus.provider';
export { scrubPgErrorPii, type PgScrubResult } from './pg-error-scrub';
export type { IAlertSink, AlertEvent, AlertSeverity } from './providers/alert/alert.interface';
export { NoopAlertSink } from './providers/alert/noop.provider';
export { WebhookAlertSink, type WebhookAlertConfig } from './providers/alert/webhook.provider';
export {
  BreachDetectionService,
  DEFAULT_BREACH_THRESHOLDS,
  type BreachThresholds,
} from './providers/alert/breach-detection.service';
