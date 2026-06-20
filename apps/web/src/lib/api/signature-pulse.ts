/**
 * Signature-pulse API client — E2 Wave-2 B1 (the board-first home's data feed).
 *
 * Wraps `GET /api/v1/org/signature-pulse` (the org-wide "signature pulse"
 * backing the mission-control home, E2.1). Defensive `.parse()` on the response
 * per docs/ARCHITECTURE-MAP §1 — the FE never trusts the wire shape.
 *
 * The endpoint is scope-aware on the BE: a manager/viewer sees the whole org;
 * an agent sees only their ASSIGNED projects. The FE doesn't re-scope — it
 * renders what the wire delivers. `attention[]` arrives ALREADY ranked
 * most-urgent-first by the server's `rankAttention` (a deterministic scorer);
 * we preserve that order end-to-end.
 *
 * NO PII: every field on the wire is a count, a derived percentage, a
 * timestamp, or the project's own id/name — no owner row data reaches here.
 */
import { SignaturePulseSchema, type SignaturePulse } from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isOk } from '../api-client';

import { ApiClientError } from './errors';

const SignaturePulseDataSchema = z.object({ data: SignaturePulseSchema });

export async function getSignaturePulse(): Promise<SignaturePulse> {
  const res = await apiClient.get<unknown>('/org/signature-pulse');
  if (!isOk(res)) throw new ApiClientError(res.error);
  return SignaturePulseDataSchema.parse({ data: res.data }).data;
}
