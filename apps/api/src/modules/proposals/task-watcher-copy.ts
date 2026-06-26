/**
 * BACKWARD-COMPAT re-export. The PII-free `task.create` copy composer + evidence
 * schema MOVED to `@emapp/db` in wave 1.2 (`packages/db/.../proposal-effects/
 * task-create-copy.ts`) so BOTH the API approve path AND the DI-free producer
 * auto-execute path import the ONE composer — no second copy implementation.
 *
 * This file is kept only so existing importers (e.g. task-watcher-copy.spec.ts)
 * resolve unchanged; new code should import from `@emapp/db` directly.
 */
export {
  composeMissingDocTask,
  MissingDocTaskEvidence,
  type ComposedTaskCopy,
  type MissingDocTaskEvidenceDto,
} from '@emapp/db';
