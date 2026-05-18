import { serverEnv } from '@emapp/config';
import { NoopSMSProvider } from '@emapp/db';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';
import { TenantGuard } from './guards/tenant.guard';
import { MeController } from './me.controller';
import { ProviderAuthController } from './provider/provider-auth.controller';
import { ProviderAuthGuard } from './provider/provider-auth.guard';
import { ProviderAuthService } from './provider/provider-auth.service';
import { OtpController } from './tenant/otp.controller';
import { OtpService, SMS_PROVIDER } from './tenant/otp.service';
import { TenantAuthGuard } from './tenant/tenant-auth.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: serverEnv.JWT_SECRET,
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController, MeController, ProviderAuthController, OtpController],
  providers: [
    AuthService,
    AuthGuard,
    TenantGuard,
    ProviderAuthService,
    ProviderAuthGuard,
    OtpService,
    TenantAuthGuard,
    // ISMSProvider behind a token — NoopSMSProvider now; the real Israeli
    // provider (019/Inforu) is a later swap here, configured via Infisical
    // (D.20 — provider swap, not an architecture change).
    { provide: SMS_PROVIDER, useClass: NoopSMSProvider },
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
  ],
})
export class AuthModule {}
