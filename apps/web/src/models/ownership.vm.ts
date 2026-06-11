/**
 * Ownership ViewModel — Doc 05 §9.8 + D.25 LAW + §SOLID-H1 closure.
 *
 * The wire shape is `ApartmentOwner` (= Owner extended with
 * `ownershipId`, `ownershipPct`, `role`). The VM:
 *  - Renames `id` → `ownerId` so callers don't conflate Owner id
 *    with Ownership id.
 *  - Surfaces only the masked PII (`nationalIdMasked`, `phoneMasked`);
 *    the VM never carries clear PII.
 *  - Exposes `displayName` separately (the caller still wraps it in
 *    `<NameDisplay>` for bidi defense).
 */
export interface OwnershipViewModel {
  ownershipId: string;
  ownerId: string;
  displayName: string;
  nationalIdMasked: string;
  phoneMasked: string | null;
  ownershipPct: number;
  /** S3c — ownerships are owner-only (occupants moved to discovery_records).
   *  Mirrors `RelationshipSchema` in shared-types. */
  relationship: 'owner';
  role: string | null;
}
