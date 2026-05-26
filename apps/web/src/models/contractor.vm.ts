/**
 * Contractor ViewModel — Phase 4f.
 *
 * Org-scoped external entity (no auth account; D.17 Tier-2 "Contractor"
 * role is bridged via Shares — see share.vm.ts). The Contractor record
 * itself is just identity + contact data (no PII outside its own email
 * + phone fields, which are NOT pgcrypto-encrypted at rest because
 * contractors are NOT residents — they're business contacts the org
 * Manager freely chose to record).
 *
 * D.17: read=ALL, create/update/delete=MGR.
 */
export interface ContractorViewModel {
  id: string;
  name: string;
  contactEmail: string;
  contactPhone: string | null;
  companyId: string | null;
  specialty: string | null;
  notes: string | null;
  isArchived: boolean;
  createdAtIso: string;
  createdRelative: string;
}
