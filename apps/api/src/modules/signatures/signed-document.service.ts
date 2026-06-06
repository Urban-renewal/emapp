import { serverEnv } from '@emapp/config';
import {
  decryptField,
  decryptOwnerName,
  documents,
  owners,
  signatures,
  withTenant,
} from '@emapp/db';
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { agentHasCapability, resolveOwnerPiiFidelity } from '../../common/authz/agent-capabilities';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureRequestsService } from './signature-requests.service';
import {
  SIGNED_DOCUMENT_RENDERER,
  type ISignedDocumentRenderer,
  type SignedCertificateData,
} from './signed-document.types';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

/**
 * ORCHESTRATION for the downloadable SIGNED ARTIFACT (signing was write-only
 * before — the resident's SVG was stored but never composed into anything a
 * manager could open).
 *
 * This service does ONLY authorization + RLS-scoped data resolution; the
 * artifact composition is delegated to an injected `ISignedDocumentRenderer`
 * (SOLID/DIP — swappable for an external e-sign integration; see
 * signed-document.types.ts).
 *
 * Authorization (matches POST /owners/:id/reveal-pii — the artifact carries
 * decrypted owner PII: the signer name + their signature):
 *   1. SR read path (get()) — existence + RLS org-scope + AGENT assigned-project
 *      visibility (an agent of project X cannot pull project Y's certificate).
 *   2. `resolveOwnerPiiFidelity === 'unmasked'` — manager always · agent iff the
 *      `view_owner_pii` capability is granted · viewer never. This is the SAME
 *      legacy fidelity gate the on-screen reveal uses (NOT engine
 *      `owners.reveal_pii`, which excludes a capability-granted agent → the
 *      split-brain we removed). Controller coarse gate = `owners.read`.
 */
@Injectable()
export class SignedDocumentService {
  private readonly logger = new Logger(SignedDocumentService.name);

  constructor(
    private readonly signatureRequests: SignatureRequestsService,
    @Inject(SIGNED_DOCUMENT_RENDERER) private readonly renderer: ISignedDocumentRenderer,
  ) {}

  async generate(
    user: AccessTokenPayload,
    signatureRequestId: string,
  ): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }> {
    const encKey = serverEnv.PII_ENCRYPTION_KEY;
    if (!encKey || encKey.length < 32) {
      this.logger.error('PII_ENCRYPTION_KEY not configured — cannot render signed document');
      throw NOT_FOUND;
    }

    // 1) SR read path → existence + RLS + agent assigned-project visibility.
    const sr = await this.signatureRequests.get(user, signatureRequestId);
    // Only a SIGNED request has an artifact. Otherwise → 404 (no oracle).
    if (sr.status !== 'signed' || !sr.signedSignatureId) throw NOT_FOUND;
    const signatureId = sr.signedSignatureId;

    const data: SignedCertificateData = await withTenant(
      user.orgId,
      async (tx) => {
        // 2) PII gate — mirror revealPii EXACTLY (both halves, locally, so we
        //    never depend on a write-time invariant in another module):
        //    (a) OUTER view_owners — an agent who cannot see owners at all
        //        cannot export one (also makes the contradictory
        //        {view_owners:false, view_owner_pii:true} grant inert here).
        if (user.role === 'agent' && !(await agentHasCapability(tx, user, 'view_owners'))) {
          throw FORBIDDEN;
        }
        //    (b) view_owner_pii fidelity — manager always · agent iff flag ·
        //        viewer never. Anything but 'unmasked' → 403.
        const fidelity = await resolveOwnerPiiFidelity(tx, user);
        if (fidelity !== 'unmasked') throw FORBIDDEN;

        const [sig] = await tx
          .select({
            blob: signatures.signatureBlob,
            documentHash: signatures.documentHash,
            authMethod: signatures.authMethod,
            signedAt: signatures.signedAt,
          })
          .from(signatures)
          .where(eq(signatures.id, signatureId))
          .limit(1);
        if (!sig) throw NOT_FOUND;

        const [doc] = await tx
          .select({ name: documents.name })
          .from(documents)
          .where(eq(documents.id, sr.documentId))
          .limit(1);
        const [own] = await tx
          .select({ nameEncrypted: owners.nameEncrypted })
          .from(owners)
          .where(eq(owners.id, sr.ownerId))
          .limit(1);
        if (!own) throw NOT_FOUND;

        // FAIL HARD on decrypt failure (D.51 — no plaster): a certificate that
        // cannot render the actual signature/signer is NOT a valid attestation.
        const signatureSvg = await decryptField(tx, sig.blob, encKey);
        const ownerName = await decryptOwnerName(tx, own.nameEncrypted);

        return {
          documentName: doc?.name ?? '—',
          documentHash: sig.documentHash,
          authMethod: sig.authMethod,
          signedAt: sig.signedAt,
          ownerName,
          signatureSvg,
        };
      },
      { userId: user.sub },
    );

    try {
      const artifact = await this.renderer.render(data);
      return {
        bytes: artifact.bytes,
        contentType: artifact.contentType,
        fileName: `signed-${signatureRequestId}.${artifact.fileExtension}`,
      };
    } finally {
      // D.50 hygiene — release decrypted PII even if the renderer throws (the
      // renderer is an injected boundary; a future external impl may fail).
      data.signatureSvg = '';
      data.ownerName = '';
    }
  }
}
