import type { NewDocument } from '../schema/artifacts';

export interface DocumentUploadPayload {
  orgId: string;
  projectId?: string;
  apartmentId?: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedBy: string;
}

export function buildDocument(payload: DocumentUploadPayload): NewDocument {
  return {
    orgId: payload.orgId,
    projectId: payload.projectId ?? null,
    apartmentId: payload.apartmentId ?? null,
    name: payload.name,
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes,
    storageKey: payload.storageKey,
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
