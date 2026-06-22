/**
 * G1 TaskWatcher — the PII-FREE, user-framed copy composer for a system-owned
 * "missing required document" task (Autonomous Master Plan, voice & agency law).
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
