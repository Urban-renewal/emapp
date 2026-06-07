import { serverEnv } from '@emapp/config';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { PermissionService } from '../../common/authz/permission.service';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';
import { TenantGuard } from './guards/tenant.guard';
import { MeController } from './me.controller';
import { ProviderAuthController } from './provider/provider-auth.controller';
import { ProviderAuthGuard } from './provider/provider-auth.guard';
import { ProviderAuthService } from './provider/provider-auth.service';
import { ProviderMeController } from './provider/provider-me.controller';
import { OtpController } from './tenant/otp.controller';
import { OtpService, SMS_PROVIDER } from './tenant/otp.service';
import { smsProviderFactory } from './tenant/sms-provider.factory';
import { TenantAuthGuard } from './tenant/tenant-auth.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: serverEnv.JWT_SECRET,
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [
    AuthController,
    MeController,
    ProviderAuthController,
    ProviderMeController,
    OtpController,
  ],
  providers: [
    AuthService,
    // IAM slice 4 — the slice-2 engine, injected into AuthService so `/me`
    // can resolve the actor's effective permission-set. ADDITIVE: still not
    // wired into any guard (the cutover is slice 5).
    PermissionService,
    AuthGuard,
    TenantGuard,
    ProviderAuthService,
    ProviderAuthGuard,
    OtpService,
    TenantAuthGuard,
    // ISMSProvider behind a token. The factory picks the real Israeli gateway
    // (Inforu) when SMS_PROVIDER_* creds are present, fails fast in production
    // if they're missing, and falls back to Noop in dev/test (D.20). Wiring
    // the real provider is now a pure Infisical config swap — no code change.
    { provide: SMS_PROVIDER, useFactory: smsProviderFactory },
  ],
  exports: [
    AuthService,
    AuthGuard,
    TenantGuard,
    ProviderAuthService,
    ProviderAuthGuard,
    OtpService,
    TenantAuthGuard,
    JwtModule,
    // Export the SMS provider so other modules (e.g. signatures) can deliver
    // via the same single configured gateway instance (D.20).
    SMS_PROVIDER,
  ],
})
export class AuthModule {}
