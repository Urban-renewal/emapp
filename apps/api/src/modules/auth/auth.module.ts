import { serverEnv } from '@emapp/config';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';
import { TenantGuard } from './guards/tenant.guard';
import { MeController } from './me.controller';

@Module({
  imports: [
    JwtModule.register({
      secret: serverEnv.JWT_SECRET,
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController, MeController],
  providers: [AuthService, AuthGuard, TenantGuard],
  exports: [AuthService, AuthGuard, TenantGuard, JwtModule],
})
export class AuthModule {}
