/**
 * G1 TaskWatcher — the PII-FREE, user-framed copy composer + evidence schema for a
 * system-owned "missing required document" task (Autonomous Master Plan).
 *
 * Lives in `@emapp/db` (wave 1.2) so BOTH the API approve path AND the DI-free
 * producer auto-execute path import the ONE composer — there is no second copy
 * implementation. Pure + dependency-light (zod only): no Nest, no `node:` modules.
 *
 * VOICE LAW (owner-mandated, non-negotiable): the system manages autonomously but
 * the FEELING OF CONTROL stays with the USER. NEVER system-first-person ("הבוקר
 * תזמנתי / פתחתי משימה"). The copy frames the user's SITUATION and a proposed next
 * step ("חסר נסח טאבו בפרויקט — מומלץ לפתוח משימה לטיפול"), never the machine as the
 * hero. See feedback_user_keeps_control_not_system_voice.
 *
 * PII-FREE by construction: the title/body interpolate ONLY a document-TYPE label
 * (taxonomy, not PII) — never an owner national_id/phone/name. The Hebrew label
 * table is the single place a doc-type string becomes display text.
 */
import { z } from 'zod';

/** Hebrew display labels for the required document types the checklist tracks.
 *  Taxonomy only — these are NOT PII. Falls back to the raw key for an unmapped
 *  type so a future required type never produces an empty title. */
const DOC_TYPE_LABEL_HE: Readonly<Record<string, string>> = {
  agreement: 'הסכם',
  land_registry: 'נסח טאבו',
  blueprint: 'תוכנית/שרטוט',
  regulation: 'תקנון',
};

export interface ComposedTaskCopy {
  title: string;
  description: string;
}

/**
 * Compose the system task's title + body for a missing required document type.
 * User-framed (the situation + a proposed action), PII-free (doc-type label only).
 */
export function composeMissingDocTask(docType: string): ComposedTaskCopy {
  const label = DOC_TYPE_LABEL_HE[docType] ?? docType;
  return {
    // The situation, framed for the user — not "the system noticed".
    title: `חסר מסמך נדרש: ${label}`,
    // A proposed next step, neutral-passive. No system-first-person.
    description: `מסמך מסוג "${label}" חסר בפרויקט שנמצא באיסוף חתימות. מומלץ להשלים אותו כדי לקדם את הפרויקט.`,
  };
}

/**
 * The shape of a `task.create` (G1 TaskWatcher) proposal's evidence snapshot the
 * effect depends on at execute time. Zod-parsed (no raw `unknown` access, per
 * CLAUDE.md) — a malformed evidence blob fails closed rather than creating a
 * mis-titled task. PII-FREE by contract: project + doc-type taxonomy only.
 */
export const MissingDocTaskEvidence = z.object({
  condition: z.literal('missing_required_doc'),
  projectId: z.string().uuid(),
  missingDocType: z.string().min(1).max(50),
});
export type MissingDocTaskEvidenceDto = z.infer<typeof MissingDocTaskEvidence>;
