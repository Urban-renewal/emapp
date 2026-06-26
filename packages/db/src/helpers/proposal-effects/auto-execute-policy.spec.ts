/**
 * AUTO-EXECUTE policy resolution + eligibility — pure unit tests (no DB).
 * (Autonomous Master Plan, wave 1.2.)
 */
import { describe, expect, it } from 'vitest';

import { autoExecutePolicyFromEnv, isAutoExecuteEligible } from '../proposal-producer';

describe('autoExecutePolicyFromEnv', () => {
  it('default OFF — unset / empty / whitespace yields an empty allowlist', () => {
    expect(autoExecutePolicyFromEnv(undefined).enabledKinds.size).toBe(0);
    expect(autoExecutePolicyFromEnv('').enabledKinds.size).toBe(0);
    expect(autoExecutePolicyFromEnv('   ').enabledKinds.size).toBe(0);
    expect(autoExecutePolicyFromEnv(', ,').enabledKinds.size).toBe(0);
  });

  it('parses + trims a comma list', () => {
    const p = autoExecutePolicyFromEnv(' task.create , document.autofile ');
    expect([...p.enabledKinds].sort()).toEqual(['document.autofile', 'task.create']);
  });
});

describe('isAutoExecuteEligible — three independent gates', () => {
  it('flag-off → not eligible even for a safe kind', () => {
    expect(isAutoExecuteEligible('task.create', { enabledKinds: new Set() })).toBe(false);
  });

  it('flag-on + safe + autoExecute → eligible', () => {
    expect(isAutoExecuteEligible('task.create', { enabledKinds: new Set(['task.create']) })).toBe(
      true,
    );
  });

  it('flag-on but OUTBOUND kind → NOT eligible (not in the safe allowlist + not autoExecute)', () => {
    for (const kind of ['document.chase.send', 'reminder.send', 'signature_request.reissue']) {
      expect(isAutoExecuteEligible(kind, { enabledKinds: new Set([kind]) })).toBe(false);
    }
  });

  it('flag-on but PII/floor kind → NOT eligible', () => {
    for (const kind of ['nationalId.export', 'status.toApproved', 'tabu.confirm.ownerships']) {
      expect(isAutoExecuteEligible(kind, { enabledKinds: new Set([kind]) })).toBe(false);
    }
  });

  it('unknown kind → NOT eligible (fail closed)', () => {
    expect(isAutoExecuteEligible('made.up.kind', { enabledKinds: new Set(['made.up.kind']) })).toBe(
      false,
    );
  });
});
