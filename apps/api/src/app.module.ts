import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { HealthController } from './app.controller';
import { ConfigurableThrottlerGuard } from './common/guards/throttler.guard';
import { ApartmentsModule } from './modules/apartments/apartments.module';
import { AuthModule } from './modules/auth/auth.module';
import { BuildingsModule } from './modules/buildings/buildings.module';
import { OwnersModule } from './modules/owners/owners.module';
import { ProjectsModule } from './modules/projects/projects.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    LoggerModule.forRoot({
      pinoHttp: {
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.token',
          // PII — owner create/update/search bodies (Doc07: never log PII).
          'req.body.national_id',
          'req.body.phone',
        ],
        level: process.env['NODE_ENV'] !== 'production' ? 'debug' : 'info',
      },
    }),
    AuthModule,
    ProjectsModule,
    BuildingsModule,
    ApartmentsModule,
    OwnersModule,
  ],
  controllers: [HealthController],
  // Rate limiting ENFORCED globally; the configurable guard adds a
  // prod-safe, env-gated per-request bypass for the conformance suite.
  providers: [{ provide: APP_GUARD, useClass: ConfigurableThrottlerGuard }],
})
export class AppModule {}
