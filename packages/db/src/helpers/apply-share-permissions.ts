import { sharePermissionsSchema } from '../schema/_share-permissions';
import type { SharePermissions } from '../schema/_share-permissions';

export function applySharePermissions(
  current: SharePermissions,
  patch: Partial<SharePermissions>,
): SharePermissions {
  const merged = {
    overview: patch.overview ?? current.overview,
    tenants: patch.tenants ?? current.tenants,
    documents: patch.documents ?? current.documents,
    signatures: patch.signatures ?? current.signatures,
    notes: patch.notes ?? current.notes,
    team: patch.team ?? current.team,
  };
  return sharePermissionsSchema.parse(merged);
}
