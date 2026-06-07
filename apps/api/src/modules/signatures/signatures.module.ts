import { serverEnv } from '@emapp/config';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthModule } from '../auth/auth.module';
import { STORAGE_PROVIDER, storageProviderFactory } from '../documents/storage';
import { EMAIL_PROVIDER, emailProviderFactory } from '../members/invite-email';
import { NotificationsModule } from '../notifications/notifications.module';

import { PdfSignedDocumentRenderer } from './pdf-signed-document.renderer';
import { PublicSignController } from './public-sign.controller';
import { PublicSignService } from './public-sign.service';
import { SignatureRequestsController } from './signature-requests.controller';
import { SignatureRequestsService } from './signature-requests.service';
import { SIGNATURE_TOKEN_SECRET, SignatureTokenService } from './signature-token.service';
import { SignedDocumentService } from './signed-document.service';
import { SIGNED_DOCUMENT_RENDERER } from './signed-document.types';

/** Phase 5 — signatures module.
 *
 * Wires:
 *  - SignatureTokenService (separate-secret JWT mint/verify per docs/03 §9)
 *  - SignatureRequestsService + controller (Manager-side create — S4-min)
 *  - PublicSignService + controller (resident-side preview/sign — S5)
 *  - STORAGE_PROVIDER (reused from DocumentsModule — same factory)
 *
 * The SIGNATURE_TOKEN_SECRET factory reads from serverEnv ONCE at module
 * load. If the env is missing, SignatureTokenService throws at
 * construction with a clear "refusing to start" message (same governed
 * pattern as the email/storage providers). */
@Module({
  imports: [
    AuthModule, // brings AuthGuard, TenantGuard, JwtService(JWT_SECRET) for Manager auth
    NotificationsModule, // exports NotificationsProducerService (post-sign in-app notify)
    JwtModule.register({
      // Module-level secret is unused for SignatureTokenService (it
      // passes the secret in each call's options) but JwtModule requires
      // a default. We use a sentinel that would fail audibly if anyone
      // mis-wires a call to JwtService without explicit secret opts.
      secret: 'signatures-module-default-do-not-use-directly',
      global: false,
    }),
  ],
  controllers: [SignatureRequestsController, PublicSignController],
  providers: [
    SignatureTokenService,
    SignatureRequestsService,
    SignedDocumentService,
    // SOLID seam — bind the renderer abstraction to the built-in pdf-lib impl.
    // Swap this useClass for an external e-sign integration with no other change.
    { provide: SIGNED_DOCUMENT_RENDERER, useClass: PdfSignedDocumentRenderer },
    PublicSignService,
    {
      provide: SIGNATURE_TOKEN_SECRET,
      useFactory: (): string => {
        const s = serverEnv.SIGNATURE_TOKEN_SECRET;
        if (!s || s.length < 44) {
          throw new Error(
            'SignaturesModule: SIGNATURE_TOKEN_SECRET missing or too short ' +
              '(min 44 chars). Add to Infisical for dev/staging/prod. ' +
              "Generate: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
          );
        }
        return s;
      },
    },
    // Re-provide STORAGE_PROVIDER. We CANNOT just import DocumentsModule
    // (would create a circular-import risk if Documents ever pulls
    // signatures). The factory is idempotent.
    { provide: STORAGE_PROVIDER, useFactory: storageProviderFactory },
    // S6 delivery — same governed pattern as documents/STORAGE_PROVIDER.
    // The factory is shared with MembersModule (D.27 invite email);
    // re-registering it here keeps the module self-contained.
    { provide: EMAIL_PROVIDER, useFactory: emailProviderFactory },
  ],
  // Exported so the Tenant Portal can reuse the resident self-resend
  // (B-RESIDENT-1) without re-wiring the token service + providers.
  exports: [SignatureRequestsService],
})
export class SignaturesModule {}
