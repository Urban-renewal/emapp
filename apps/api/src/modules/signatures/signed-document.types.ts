/**
 * SOLID seam for the signed-artifact pipeline (owner directive: signing must be
 * modular so a future EXTERNAL e-sign system / closed process can be swapped in
 * without touching the orchestration or the HTTP layer).
 *
 * `SignedDocumentService` (orchestration: authz + RLS-scoped data load) depends
 * on the `ISignedDocumentRenderer` ABSTRACTION (DIP), not on pdf-lib. The
 * built-in `PdfSignedDocumentRenderer` is one implementation; an external
 * integration is just another binding of `SIGNED_DOCUMENT_RENDERER` — zero
 * change to the service or controller (OCP). The renderer reports its own
 * content-type + extension so a non-PDF artifact (e.g. an external provider's
 * signed package) flows through unchanged.
 */

/** The facts a renderer needs to produce a signed artifact. No DB / no R2 —
 *  the orchestration resolves + decrypts these and hands them over. */
export interface SignedCertificateData {
  /** Human name of the document that was signed. */
  documentName: string;
  /** Content hash binding the artifact to the exact signed bytes (SHA-256). */
  documentHash: string;
  /** How the signature was authenticated (e.g. 'public_link_v1'). */
  authMethod: string;
  /** When the signature was captured (UTC; renderer localises). */
  signedAt: Date;
  /** Decrypted signer (owner) name. PII — renderer MUST NOT log it. */
  ownerName: string;
  /** Decrypted signature SVG markup. PII — renderer MUST NOT log it. */
  signatureSvg: string;
}

/** A rendered, downloadable artifact + how to serve it. */
export interface RenderedArtifact {
  bytes: Uint8Array;
  /** MIME type for the HTTP response (e.g. 'application/pdf'). */
  contentType: string;
  /** File extension WITHOUT the dot (e.g. 'pdf'). */
  fileExtension: string;
}

/** The swappable renderer abstraction. Implementations: the built-in pdf-lib
 *  certificate renderer, or a future external e-sign integration. */
export interface ISignedDocumentRenderer {
  render(data: SignedCertificateData): Promise<RenderedArtifact>;
}

/** DI token — bind to a concrete renderer in SignaturesModule. */
export const SIGNED_DOCUMENT_RENDERER = Symbol('SIGNED_DOCUMENT_RENDERER');
