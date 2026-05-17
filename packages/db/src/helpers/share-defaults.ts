import type { SharePermissions } from '../schema/_share-permissions';

export function defaultSharePermissions(): SharePermissions {
  return {
    overview: { on: true },
    tenants: {
      on: true,
      fields: {
        name: true,
        phone: false,
        email: false,
        national_id: false,
        note: false,
      },
    },
    documents: {
      on: true,
      actions: { download: true, upload: false },
    },
    signatures: { on: false },
    notes: { on: false },
    team: { on: false },
  };
}
