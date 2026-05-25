import type { SignatureDeliveryReport, SignatureRequest } from '@emapp/shared-types';

/** SAMPLE_SIGNATURE_REQUESTS — pending + signed + cancelled, one row
 *  each (D.12 LAW). UUIDs are valid hex-only shapes — `o`/`s` are
 *  not [0-9a-f] so we use `aaaaaaaa-…`-style hex prefixes instead.
 *  The wire shape never carries `jti` or the raw JWT; these fixtures
 *  match the wire surface exactly. */
export const SAMPLE_SIGNATURE_REQUESTS: SignatureRequest[] = [
  {
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    organizationId: '22222222-2222-4222-8222-222222222222',
    documentId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    ownerId: 'cccccccc-1111-4111-8111-cccccccccccc',
    status: 'pending',
    expiresAt: new Date('2026-06-01T10:00:00Z'),
    createdBy: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date('2026-05-25T10:00:00Z'),
    signedAt: null,
    signedSignatureId: null,
    cancelledAt: null,
    cancelledBy: null,
  },
  {
    id: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    organizationId: '22222222-2222-4222-8222-222222222222',
    documentId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    ownerId: 'cccccccc-2222-4222-8222-cccccccccccc',
    status: 'signed',
    expiresAt: new Date('2026-05-30T10:00:00Z'),
    createdBy: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date('2026-05-22T10:00:00Z'),
    signedAt: new Date('2026-05-23T14:00:00Z'),
    signedSignatureId: 'dddddddd-2222-4222-8222-dddddddddddd',
    cancelledAt: null,
    cancelledBy: null,
  },
  {
    id: 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa',
    organizationId: '22222222-2222-4222-8222-222222222222',
    documentId: 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb',
    ownerId: 'cccccccc-3333-4333-8333-cccccccccccc',
    status: 'cancelled',
    expiresAt: new Date('2026-05-30T10:00:00Z'),
    createdBy: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date('2026-05-20T10:00:00Z'),
    signedAt: null,
    signedSignatureId: null,
    cancelledAt: new Date('2026-05-21T12:00:00Z'),
    cancelledBy: '11111111-1111-4111-8111-111111111111',
  },
];

/** SAMPLE_SIGNATURE_DELIVERY — what the create-response delivery
 *  report looks like in MVP (email sent, whatsapp deep-link ready,
 *  sms unavailable until D.20 Israeli SMS provider lands in prod). */
export const SAMPLE_SIGNATURE_DELIVERY: SignatureDeliveryReport = {
  email: { available: true, status: 'sent', to: 'pi***@example.com' },
  whatsapp: {
    available: true,
    status: 'ready',
    deepLink: 'https://wa.me/972500000000?text=mock',
  },
  sms: { available: false, reason: 'sms_provider_not_configured' },
};
