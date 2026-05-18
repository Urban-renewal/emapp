import type { NewDocument } from '../schema/artifacts';

export interface DocumentUploadPayload {
  orgId: string;
  projectId?: string;
  apartmentId?: string;
  name: string;
  type: string;
  mimeType: string;
  sizeBytes: number;
  r2Key: string;
  contentHash: string;
  uploadedBy: string;
}

export function buildDocument(payload: DocumentUploadPayload): NewDocument {
  return {
    orgId: payload.orgId,
    projectId: payload.projectId ?? null,
    apartmentId: payload.apartmentId ?? null,
    name: payload.name,
    type: payload.type,
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes,
    r2Key: payload.r2Key,
    contentHash: payload.contentHash,
    uploadedBy: payload.uploadedBy,
  };
}

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export function validateDocumentUpload(mimeType: string, sizeBytes: number): void {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported file type: ${mimeType}`);
  }
  if (sizeBytes > MAX_SIZE_BYTES) {
    throw new Error(`File exceeds maximum size of ${MAX_SIZE_BYTES / 1024 / 1024} MB`);
  }
}
