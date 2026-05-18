import { serverEnv } from '@emapp/config';
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

@Module({
  imports: [
    JwtModule.register({
      secret: serverEnv.JWT_SECRET,
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController, MeController, ProviderAuthController],
  providers: [AuthService, AuthGuard, TenantGuard, ProviderAuthService, ProviderAuthGuard],
  exports: [AuthService, AuthGuard, TenantGuard, ProviderAuthService, ProviderAuthGuard, JwtModule],
})
export class AuthModule {}
