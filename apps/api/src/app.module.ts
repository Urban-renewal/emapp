import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { HealthController } from './app.controller';
import { ConfigurableThrottlerGuard } from './common/guards/throttler.guard';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { ApartmentsModule } from './modules/apartments/apartments.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BuildingsModule } from './modules/buildings/buildings.module';
import { ContractorsModule } from './modules/contractors/contractors.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { MembersModule } from './modules/members/members.module';
import { NotesModule } from './modules/notes/notes.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OwnersModule } from './modules/owners/owners.module';
import { OwnershipsModule } from './modules/ownerships/ownerships.module';
import { ProjectAssignmentsModule } from './modules/project-assignments/project-assignments.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SharesModule } from './modules/shares/shares.module';
import { TasksModule } from './modules/tasks/tasks.module';

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
    OwnershipsModule,
    ContractorsModule,
    DocumentsModule,
    SharesModule,
    TasksModule,
    NotificationsModule,
    NotesModule,
    AuditModule,
    ProjectAssignmentsModule,
    MembersModule,
  ],
  controllers: [HealthController],
  // Rate limiting ENFORCED globally; the configurable guard adds a
  // prod-safe, env-gated per-request bypass for the conformance suite.
  providers: [
    { provide: APP_GUARD, useClass: ConfigurableThrottlerGuard },
    // Optional-but-honoured Idempotency-Key on mutating POSTs (D.16-safe
    // replay, concurrency-correct). Global; no-ops unless the header is
    // present on a non-auth POST.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
