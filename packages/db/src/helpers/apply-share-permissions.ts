import { sharePermissionsSchema } from '../schema/_share-permissions';
import type { SharePermissions } from '../schema/_share-permissions';

export function applySharePermissions(
  current: SharePermissions,
  patch: Partial<SharePermissions>,
): SharePermissions {
  const merged = {
    overview: patch.overview ?? current.overview,
    documents: patch.documents ?? current.documents,
    signatures: patch.signatures ?? current.signatures,
  };
  return sharePermissionsSchema.parse(merged);
}
