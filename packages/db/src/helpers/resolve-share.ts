import { sharePermissionsSchema } from '../schema/_share-permissions';
import type { SharePermissions } from '../schema/_share-permissions';

export function resolveSharePermissions(raw: unknown): SharePermissions {
  return sharePermissionsSchema.parse(raw);
}

export function canDownloadDocuments(perms: SharePermissions): boolean {
  return perms.documents.on && perms.documents.actions.download;
}

export function canUploadDocuments(perms: SharePermissions): boolean {
  return perms.documents.on && perms.documents.actions.upload;
}

export function canViewTenants(perms: SharePermissions): boolean {
  return perms.tenants.on;
}

export function canViewTenantPhone(perms: SharePermissions): boolean {
  return perms.tenants.on && perms.tenants.fields.phone;
}

export function canViewTenantEmail(perms: SharePermissions): boolean {
  return perms.tenants.on && perms.tenants.fields.email;
}

export function canViewTenantNationalId(perms: SharePermissions): boolean {
  return perms.tenants.on && perms.tenants.fields.national_id;
}

export function canViewSignatures(perms: SharePermissions): boolean {
  return perms.signatures.on;
}

export function canViewNotes(perms: SharePermissions): boolean {
  return perms.notes.on;
}

export function canViewTeam(perms: SharePermissions): boolean {
  return perms.team.on;
}
