/**
 * Worker storage-provider factory — Phase 6.
 *
 * Same GOVERNED pattern as apps/api/src/modules/documents/storage.ts:
 *  - dev/test  → FakeStorageProvider (in-memory, mints fake URLs +
 *    a Map<key, Buffer> the parser tests seed)
 *  - production → FAIL FAST until R2 (Cloudflare R2 swap is a hard
 *    pre-Gate-5 obligation; D.28 governs the residuals at swap day)
 *
 * Lives in apps/worker/ (not @emapp/db) because each app boots its own
 * provider — dependency-injected at the application composition root.
 * The factory pattern keeps the IStorageProvider import boundary
 * uniform across apps/api and apps/worker.
 *
 * NOT exposed via NestJS DI (the worker has no Nest container) — the
 * worker's composition root is `main.ts`, which constructs the
 * provider once and passes it into the handler.
 */
import { FakeStorageProvider, type IStorageProvider } from '@emapp/db';

export function storageProviderFactory(): IStorageProvider {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'STORAGE_PROVIDER (worker): refusing to boot — production requires ' +
        'Cloudflare R2 (Phase 4 / Gate-4 SECRETS LAW). FakeStorageProvider ' +
        'has no real bytes — the worker would fail every import. Provision ' +
        'R2 (bucket + R2_* creds + S3 client) and wire R2StorageProvider ' +
        'here before deploying. See GATES Gate-5 / DECISIONS D.28.',
    );
  }
  return new FakeStorageProvider();
}
