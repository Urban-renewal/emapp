/**
 * Situation-picture board primitives — barrel.
 *
 * ONE source of truth for the board-first pattern (pulse sentence → ranked
 * attention ActionCards with holdout drill-down + one-click chase → fleet
 * tiles), shared by the mission-control HOME (E2.1) and the SIGNATURES
 * situation-picture (signature-requests redesign Slice 1). Extracted from
 * `mission-control-home.tsx` so neither surface duplicates the primitives.
 */
export {
  ActionCard,
  AllClearBadge,
  buildFleetTag,
  buildGreeting,
  buildHoldoutRemindErrorMessage,
  buildPulseSentence,
  buildRemindErrorMessage,
  buildRemindResultMessage,
  buildTag,
  buildWhy,
  FleetSection,
  FleetTile,
  HoldoutApartment,
  HoldoutExpander,
  HoldoutRow,
  RemindButton,
} from './board-primitives';
