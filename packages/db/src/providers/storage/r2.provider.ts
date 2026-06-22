import { Readable } from 'node:stream';

import { recordStorageError } from '../../client';

import type {
  IStorageProvider,
  UploadUrlOptions,
  DownloadUrlOptions,
  StorageObjectMeta,
} from './storage.interface';

/** D.37 / Phase 6.5 — wrap an S3 SDK call so any error increments
 *  the storage-error counter (surfaced via getStorageErrorStats()
 *  → GET /provider/system-health) before being rethrown. The catch
 *  is invisible to the caller (just rethrows) — pure observability. */
async function withErrorTelemetry<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { name?: string };
    recordStorageError({ op, errorClass: err?.name ?? 'unknown' });
    throw e;
  }
}

/** R2/S3 SDK error shape — we only care about the `name` discriminator
 *  (`NotFound` / `NoSuchKey`) so we can map a missing object to `null`
 *  rather than a thrown exception. */
interface S3LikeError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

interface S3ClientLike {
  /** Second arg is the AWS SDK's optional `HttpHandlerOptions` (we
   *  use it only for `{ abortSignal }` v8 SOLID-6). Kept loose to
   *  avoid pulling in @smithy/* types — the real SDK accepts any
   *  shape compatible with this. */
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

interface SignedUrlFn {
  (
    client: S3ClientLike,
    command: unknown,
    /** Mirrors `@aws-sdk/s3-request-presigner`'s `RequestPresigningArguments`
     *  for the subset we use. `signableHeaders` forces a header into the
     *  presigned URL's `X-Amz-SignedHeaders` (so R2 ENFORCES it — the client
     *  MUST send it). `unhoistableHeaders` keeps a header OUT of the query
     *  string (it stays a header the client sends, rather than being hoisted
     *  and baked into the URL). B7: without `signableHeaders` the SDK does NOT
     *  sign `if-none-match` / `x-amz-checksum-sha256`, so the create-only +
     *  checksum binding would be COSMETIC (R2 wouldn't require them). */
    opts: {
      expiresIn: number;
      signableHeaders?: Set<string>;
      unhoistableHeaders?: Set<string>;
    },
  ): Promise<string>;
}

interface R2Deps {
  client: S3ClientLike;
  getSignedUrl: SignedUrlFn;
  PutObjectCommand: new (opts: {
    Bucket: string;
    Key: string;
    ContentType: string;
    ContentLength: number;
    /** 7d server-side putObject — the real SDK accepts the body inline;
     *  presign-minting call sites simply omit it. */
    Body?: Buffer;
    /** B7 — create-only guard. `'*'` makes S3/R2 reject a PUT to an
     *  already-existing key (412 PreconditionFailed). Presigned into the
     *  URL so the storage layer enforces single-shot upload (anti-דריסה). */
    IfNoneMatch?: string;
    /** B7 — base64 sha256 the uploaded bytes MUST hash to. S3/R2 rejects
     *  (BadDigest) on mismatch, binding the URL to the declared content. */
    ChecksumSHA256?: string;
  }) => unknown;
  GetObjectCommand: new (opts: {
    Bucket: string;
    Key: string;
    ResponseContentDisposition?: string;
    ResponseContentType?: string;
  }) => unknown;
  DeleteObjectCommand: new (opts: { Bucket: string; Key: string }) => unknown;
  HeadObjectCommand: new (opts: {
    Bucket: string;
    Key: string;
    /** B7 — REQUIRED to make S3/R2 return `ChecksumSHA256` on the HEAD
     *  response. Without `ChecksumMode:'ENABLED'` the checksum is omitted
     *  even for objects stored WITH a checksum, which the fail-closed
     *  finalize gate would (incorrectly) read as "no attestation". */
    ChecksumMode?: 'ENABLED';
  }) => unknown;
  ListObjectsV2Command: new (opts: { Bucket: string; MaxKeys: number }) => unknown;
}

/** Shape S3/R2's `HeadObject` response actually carries. We type just
 * the bits we read so the rest of the SDK shape is unconstrained. */
interface HeadObjectResponse {
  ContentLength?: number;
  ChecksumSHA256?: string; // R2 attests this when uploaded with checksum
}

export class R2StorageProvider implements IStorageProvider {
  private readonly bucket: string;
  private readonly deps: R2Deps;

  constructor(bucket: string, deps: R2Deps) {
    this.bucket = bucket;
    this.deps = deps;
  }

  async getUploadUrl(key: string, opts: UploadUrlOptions): Promise<string> {
    return withErrorTelemetry('getUploadUrl', () => {
      // B7 (DOCUMENT-SECURITY-AUDIT.md) — harden the presigned PUT against
      // overwrite/tamper (דריסה):
      //   • createOnly  → `IfNoneMatch:'*'` makes R2 reject a PUT to an
      //     already-existing key (412). A leaked URL can upload ONCE; a
      //     second PUT (the scan-then-swap) is refused by storage.
      //   • contentSha256Hex → bind `x-amz-checksum-sha256` so R2 rejects
      //     (BadDigest) any bytes that don't hash to the declared value.
      //     S3's checksum header is base64 of the RAW digest, so we convert
      //     the hex hash the rest of the app uses into base64 here.
      // Only bind a checksum when the hex decodes to EXACTLY a 32-byte sha256
      // digest. `Buffer.from(hex,'hex')` silently DROPS non-hex chars and
      // truncates odd-length input, so a malformed value would otherwise
      // produce a wrong-length checksum that R2 rejects with an opaque error.
      // A malformed/non-canonical hash therefore degrades SAFELY to a
      // create-only PUT with no checksum binding — and finalize's layer-2
      // (which compares the real R2-attested checksum against content_hash)
      // still rejects the mismatch fail-closed. No false-accept either way.
      const checksumB64 = (() => {
        if (!opts.contentSha256Hex) return undefined;
        const raw = Buffer.from(opts.contentSha256Hex, 'hex');
        return raw.length === 32 ? raw.toString('base64') : undefined;
      })();
      const cmd = new this.deps.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: opts.contentType,
        ContentLength: opts.maxSizeBytes,
        ...(opts.createOnly ? { IfNoneMatch: '*' } : {}),
        ...(checksumB64 ? { ChecksumSHA256: checksumB64 } : {}),
      });
      // B7 — the create-only / checksum guards on the COMMAND are not enough:
      // the presigner only puts a header into `X-Amz-SignedHeaders` (so R2
      // ENFORCES it) if the header is in `signableHeaders`. Without this, a
      // leaked URL could still overwrite (scan-then-swap / דריסה) by issuing a
      // PUT that simply omits `If-None-Match` / `x-amz-checksum-sha256`. We sign
      // ONLY the headers we actually set, so legacy callers (no createOnly, no
      // checksum) keep an unchanged URL. `x-amz-checksum-sha256` is ALSO marked
      // unhoistable so it stays a request header the client must send (rather
      // than being hoisted into the query string) — the client then transmits
      // the same checksum, and R2 verifies the bytes against it (BadDigest on
      // mismatch). The FE upload path (apps/web .../documents.ts uploadToPresigned)
      // sends both headers to match.
      const signableHeaders = new Set<string>();
      if (opts.createOnly) signableHeaders.add('if-none-match');
      if (checksumB64) signableHeaders.add('x-amz-checksum-sha256');
      const presignOpts: {
        expiresIn: number;
        signableHeaders?: Set<string>;
        unhoistableHeaders?: Set<string>;
      } = { expiresIn: opts.ttlSeconds };
      if (signableHeaders.size > 0) presignOpts.signableHeaders = signableHeaders;
      if (checksumB64) presignOpts.unhoistableHeaders = new Set(['x-amz-checksum-sha256']);
      return this.deps.getSignedUrl(this.deps.client, cmd, presignOpts);
    });
  }

  async getDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string> {
    return withErrorTelemetry('getDownloadUrl', () => {
      // Audit H-2 fix (2026-05-27 manager-be-redteam): build the
      // Content-Disposition with BOTH RFC 6266 `filename=` AND RFC
      // 5987 `filename*=UTF-8''<%-encoded>` when a UTF-8 name is
      // supplied. Caller pre-sanitises the ASCII slot via
      // `safeDownloadFilename` (no `;`, `=`, `,`, control chars, or
      // non-ASCII bytes — so `;`-split parsers can't be fooled into
      // picking an attacker-chosen filename out of an embedded
      // semicolon). Hebrew filenames flow through the UTF-8 slot
      // instead of being silently stripped.
      // `inline` lets the browser RENDER the object (PDF preview); the
      // default `attachment` forces a save dialog. The filename slots are
      // appended to whichever disposition type is in effect.
      const dispositionType = opts.disposition === 'inline' ? 'inline' : 'attachment';
      let disp: string | undefined;
      if (opts.responseFilename) {
        disp = `${dispositionType}; filename="${opts.responseFilename}"`;
        if (opts.responseFilenameUtf8) {
          disp += `; filename*=UTF-8''${encodeURIComponent(opts.responseFilenameUtf8)}`;
        }
      } else if (opts.disposition === 'inline') {
        // No filename supplied but inline requested — still set the bare
        // `inline` type so the browser previews instead of downloading.
        disp = 'inline';
      }
      const cmd = new this.deps.GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: disp,
        // Pin the response content-type to the declared (allow-listed +
        // magic-byte-verified) MIME so the R2 origin can't echo an
        // attacker-influenced stored type and the browser doesn't sniff.
        ...(opts.responseContentType ? { ResponseContentType: opts.responseContentType } : {}),
      });
      return this.deps.getSignedUrl(this.deps.client, cmd, { expiresIn: opts.ttlSeconds });
    });
  }

  /** 7d — server-side object write (sensitive-document app-envelope). The
   *  bytes here are ALWAYS the opaque EMAPPENC ciphertext envelope, never
   *  plaintext document content — nothing sensitive to log either way. */
  async putObject(key: string, body: Buffer, opts?: { contentType?: string }): Promise<void> {
    await withErrorTelemetry('putObject', () =>
      this.deps.client.send(
        new this.deps.PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: opts?.contentType ?? 'application/octet-stream',
          ContentLength: body.length,
          Body: body,
        }),
      ),
    );
  }

  async delete(key: string): Promise<void> {
    await withErrorTelemetry('delete', () =>
      this.deps.client.send(new this.deps.DeleteObjectCommand({ Bucket: this.bucket, Key: key })),
    );
  }

  /** Phase 6 worker: stream the object bytes for ExcelJS streaming
   *  parse. The S3 SDK v3 GetObjectCommand returns `{ Body }` which in
   *  Node is a Readable. Caller MUST consume or destroy the stream
   *  (otherwise we leak an open R2 connection from the pool). */
  async getObjectStream(key: string): Promise<Readable> {
    return withErrorTelemetry('getObjectStream', async () => {
      const cmd = new this.deps.GetObjectCommand({ Bucket: this.bucket, Key: key });
      const res = (await this.deps.client.send(cmd)) as { Body?: unknown };
      const body = res?.Body;
      if (!body || typeof (body as Readable).pipe !== 'function') {
        throw new Error(`R2: GetObject for ${key} returned no streamable body`);
      }
      return body as Readable;
    });
  }

  /** D.28 R1/R2: storage-attested object metadata. Returns:
   *   - `{ contentLength, checksumSha256? }` when the object exists.
   *   - `null` when the object is absent (404 / NotFound / NoSuchKey).
   *  Any other failure (network, auth, 5xx) RETHROWS — those are infra
   *  problems the caller should surface, not silently treat as "no
   *  attestation". (Treating a 500 as null would let a tampered upload
   *  pass the finalize integrity gate during an R2 outage.) */
  async head(key: string, opts?: { signal?: AbortSignal }): Promise<StorageObjectMeta | null> {
    try {
      // AWS SDK v3 client.send() accepts `{ abortSignal }` to plumb
      // an AbortController through to the underlying request — the
      // socket is torn down when the signal fires. v8 SOLID-6.
      const sendOpts = opts?.signal ? { abortSignal: opts.signal } : undefined;
      const res = (await this.deps.client.send(
        // B7 — `ChecksumMode:'ENABLED'` makes R2 return the stored object's
        // `x-amz-checksum-sha256`, which the finalize integrity gate compares
        // against the create-declared content hash (tamper-evidence). Omitting
        // it would yield `undefined` for EVERY object → fail-closed finalize
        // would reject all legitimate uploads.
        new this.deps.HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ChecksumMode: 'ENABLED',
        }),
        sendOpts,
      )) as HeadObjectResponse;
      if (typeof res?.ContentLength !== 'number') return null;
      return {
        contentLength: res.ContentLength,
        ...(typeof res.ChecksumSHA256 === 'string' ? { checksumSha256: res.ChecksumSHA256 } : {}),
      };
    } catch (e) {
      const err = e as S3LikeError;
      const status = err?.$metadata?.httpStatusCode;
      const name = err?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
        // 404 is a documented "object missing" outcome, NOT an error.
        // Recording it would pollute the storage-error gauge.
        return null;
      }
      // Real failure — record + rethrow so the counter reflects it
      // and the caller can decide how to react.
      recordStorageError({ op: 'head', errorClass: name ?? 'unknown' });
      throw e;
    }
  }

  async healthCheck(): Promise<void> {
    await withErrorTelemetry('healthCheck', () =>
      this.deps.client.send(
        new this.deps.ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }),
      ),
    );
  }
}
