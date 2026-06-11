import { z } from 'zod';

import { AgentCapabilitiesSchema, type AgentCapabilities } from './member';

// ───────────────────────────────────────────────────────────────────
// S4b · #8 — capability PRESETS (design §7). A CODE-DEFINED (NO table)
// catalog of named role presets, each bundling a FULL 7-flag
// `AgentCapabilities` set with a Hebrew (non-technical) + English
// name/description. A non-technical manager picks a named preset instead
// of toggling the 7 raw capability flags; the raw toggles remain for
// fine-tuning. Applying a preset goes through the SAME
// updateCapabilities path (agent-only / withTenant / audit / anti-
// escalation) — the preset only supplies the bundle.
//
// The bundles are validated against `AgentCapabilitiesSchema` at module
// load (see CAPABILITY_PRESETS below) so a typo'd / missing / extra flag
// fails fast at import, not at runtime on the wire.
// ───────────────────────────────────────────────────────────────────

export const CapabilityPresetSchema = z
  .object({
    /** Stable machine identifier (unique across the catalog). */
    key: z.string().min(1),
    nameHe: z.string().min(1),
    nameEn: z.string().min(1),
    descriptionHe: z.string().min(1),
    descriptionEn: z.string().min(1),
    /** A complete, valid bundle of all 7 agent capability flags. */
    capabilities: AgentCapabilitiesSchema,
  })
  .strict();
export type CapabilityPreset = z.infer<typeof CapabilityPresetSchema>;

/**
 * Helper to declare a preset with the bundle validated at module load.
 * A bad bundle throws at import (fail-fast) instead of shipping a broken
 * preset to the wire.
 */
function definePreset(p: {
  key: string;
  nameHe: string;
  nameEn: string;
  descriptionHe: string;
  descriptionEn: string;
  capabilities: AgentCapabilities;
}): CapabilityPreset {
  return CapabilityPresetSchema.parse(p);
}

export const CAPABILITY_PRESETS: readonly CapabilityPreset[] = [
  // מנהל-פרויקט — full access to project data, owners, and signatures.
  definePreset({
    key: 'project_manager',
    nameHe: 'מנהל-פרויקט',
    nameEn: 'Project manager',
    descriptionHe: 'גישה מלאה לנתוני הפרויקט, בעלים, וחתימות',
    descriptionEn: 'Full access to project data, owners, and signatures',
    capabilities: {
      edit_project_data: true,
      manage_documents: true,
      manage_signatures: true,
      manage_tasks: true,
      run_imports: true,
      view_owners: true,
      view_owner_pii: true,
    },
  }),
  // רכז-שטח — field work: edit data, view owners, manage signatures &
  // field caps; NO unmasked-PII / org-governance.
  definePreset({
    key: 'field_coordinator',
    nameHe: 'רכז-שטח',
    nameEn: 'Field coordinator',
    descriptionHe: 'עריכת נתוני שטח, צפייה בבעלים, וניהול חתימות — בלי הגדרות ארגון',
    descriptionEn: 'Edit field data, view owners, manage signatures — without org settings',
    capabilities: {
      edit_project_data: true,
      manage_documents: true,
      manage_signatures: true,
      manage_tasks: true,
      run_imports: true,
      view_owners: true,
      // governance-ish / sensitive: unmasked PII stays OFF.
      view_owner_pii: false,
    },
  }),
  // צופה — read-only owners (national_id masked).
  definePreset({
    key: 'viewer_only',
    nameHe: 'צופה',
    nameEn: 'Viewer',
    descriptionHe: 'צפייה בלבד בבעלים (ת.ז. מוסתרת)',
    descriptionEn: 'View-only owners (national_id masked)',
    capabilities: {
      edit_project_data: false,
      manage_documents: false,
      manage_signatures: false,
      manage_tasks: false,
      run_imports: false,
      view_owners: true,
      view_owner_pii: false,
    },
  }),
] as const;

/** Look up a preset by its machine key. Returns undefined for an unknown key. */
export function findCapabilityPreset(key: string): CapabilityPreset | undefined {
  return CAPABILITY_PRESETS.find((p) => p.key === key);
}

/** POST /members/:userId/apply-capability-preset — apply a named preset. */
export const ApplyCapabilityPresetInput = z.object({ presetKey: z.string().min(1) }).strict();
export type ApplyCapabilityPreset = z.infer<typeof ApplyCapabilityPresetInput>;
