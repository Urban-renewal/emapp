import { sharePermissionsSchema } from '../schema/_share-permissions';
import type { SharePermissions } from '../schema/_share-permissions';

export function resolveSharePermissions(raw: unknown): SharePermissions {
  return sharePermissionsSchema.parse(raw);
}

export function canDownloadDocuments(perms: SharePermissions): boolean {
  return perms.documents.on && perms.documents.actions.download;
}

export function canViewSignatures(perms: SharePermissions): boolean {
  return perms.signatures.on;
}

/**
 * D.46 — the signature-progress SCOPE a contractor share grants. Returns
 * only `'none' | 'aggregate'` — there is NO `'individual'` branch by
 * design: a contractor NEVER sees who signed, only the aggregate %/counts.
 * Any contractor-facing signature read MUST go through this resolver so the
 * "aggregate % only" rule (D.46) is structurally impossible to violate —
 * the type itself forbids returning per-owner signature data.
 */
export function signatureScopeForShare(perms: SharePermissions): 'none' | 'aggregate' {
  return perms.signatures.on ? 'aggregate' : 'none';
}
