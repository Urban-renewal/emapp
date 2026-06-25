import type { ProposalView } from '@emapp/shared-types';

/**
 * SAMPLE_PROPOSALS — the Approval Inbox's offline fixture (Autonomous Master
 * Plan, Phase 1). Multiple PENDING proposals across several KINDS so the offline
 * inbox renders its scale-ready situation-picture: the HONEST pending-count lead
 * line, the kind FILTER, and the per-kind GROUPING (NOT a flat wall).
 *
 * PII-FREE by contract (the same contract the BE enforces): `evidence` carries
 * only ids / counts / timestamps — never a name / national_id / phone. UUIDs are
 * valid hex-only shapes. Every row is `pending` (the only actionable state) with
 * `actorType: 'system'` (the engine authored the draft) and `appliedAt: null`.
 */
export const SAMPLE_PROPOSALS: ProposalView[] = [
  {
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaa01',
    orgId: '22222222-2222-4222-8222-222222222222',
    kind: 'signature_request.reissue',
    status: 'pending',
    scopeType: 'signature_request',
    scopeId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    evidence: {
      signatureRequestId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
      reason: 'expired_unsigned',
    },
    expiresAt: new Date('2026-07-01T10:00:00Z'),
    actorType: 'system',
    createdAt: new Date('2026-06-24T08:00:00Z'),
    appliedAt: null,
  },
  {
    id: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaa02',
    orgId: '22222222-2222-4222-8222-222222222222',
    kind: 'signature_request.reissue',
    status: 'pending',
    scopeType: 'signature_request',
    scopeId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    evidence: {
      signatureRequestId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      reason: 'expired_unsigned',
    },
    expiresAt: new Date('2026-07-01T10:00:00Z'),
    actorType: 'system',
    createdAt: new Date('2026-06-24T07:30:00Z'),
    appliedAt: null,
  },
  {
    id: 'aaaaaaaa-3333-4333-8333-aaaaaaaaaa03',
    orgId: '22222222-2222-4222-8222-222222222222',
    kind: 'reminder.send',
    status: 'pending',
    scopeType: 'signature_request',
    scopeId: 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb',
    evidence: { signatureRequestId: 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb', cadenceStep: 1 },
    expiresAt: new Date('2026-07-01T10:00:00Z'),
    actorType: 'system',
    createdAt: new Date('2026-06-24T06:45:00Z'),
    appliedAt: null,
  },
  {
    id: 'aaaaaaaa-4444-4444-8444-aaaaaaaaaa04',
    orgId: '22222222-2222-4222-8222-222222222222',
    kind: 'document.chase.send',
    status: 'pending',
    scopeType: 'project',
    scopeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    evidence: {
      condition: 'missing_required_doc',
      projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      missingDocType: 'blueprint',
    },
    expiresAt: new Date('2026-07-01T10:00:00Z'),
    actorType: 'system',
    createdAt: new Date('2026-06-24T06:00:00Z'),
    appliedAt: null,
  },
  {
    id: 'aaaaaaaa-5555-4555-8555-aaaaaaaaaa05',
    orgId: '22222222-2222-4222-8222-222222222222',
    kind: 'task.create',
    status: 'pending',
    scopeType: 'project',
    scopeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    evidence: {
      condition: 'missing_required_doc',
      projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
      missingDocType: 'land_registry',
    },
    expiresAt: new Date('2026-07-01T10:00:00Z'),
    actorType: 'system',
    createdAt: new Date('2026-06-24T05:30:00Z'),
    appliedAt: null,
  },
];
