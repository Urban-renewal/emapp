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

/** Slice 2.7 — Hebrew labels for the BLOCKING apartment-state kinds the
 *  apartment-blocker recommender flags. Taxonomy only — NOT PII. */
const BLOCKING_APARTMENT_STATE_LABEL_HE: Readonly<Record<string, string>> = {
  deceased: 'בעלים רשום נפטר',
  dispute: 'סכסוך בעלות',
  eviction: 'הליך פינוי',
};

/**
 * Slice 2.7 — compose the system task's title + body for an apartment flagged with a
 * BLOCKING legal state (deceased / dispute / eviction) in a gathering-signatures
 * project. User-framed (the situation + a proposed action). PII-FREE: the copy
 * interpolates ONLY the state-kind label (taxonomy) — apartment_states has no PII.
 * The apartment is referred to generically ("דירה בפרויקט"); the manager opens the
 * task and resolves it on the apartment dossier (where the state badge lives).
 */
export function composeApartmentBlockerTask(stateKind: string): ComposedTaskCopy {
  const label = BLOCKING_APARTMENT_STATE_LABEL_HE[stateKind] ?? stateKind;
  return {
    title: `דירה חסומה: ${label}`,
    description: `דירה בפרויקט שנמצא באיסוף חתימות מסומנת במצב משפטי חוסם (${label}). מומלץ לפתוח משימה לבירור והסדרת ההליך לפני המשך איסוף החתימות.`,
  };
}
