-- 0053 — project intermediate signature milestones (owner-approved Gate-6, Option A).
-- Additive + reversible (D.39 posture): a NULLABLE jsonb column, no default.
-- Holds an ORDERED list of intermediate signature targets (e.g. 25% → 50% → 66%)
-- used to track signature-collection progress in stages. The single legal/consent
-- gate stays `projects.target_signature_pct`; milestones are the staged overlay.
-- Shape is validated at the Zod boundary (SignatureMilestoneSchema in shared-types),
-- not by a DB CHECK — closed structural validation lives at the API edge.
ALTER TABLE projects ADD COLUMN signature_milestones jsonb;
