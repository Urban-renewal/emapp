import { Module } from '@nestjs/common';

import { CalendarModule } from '../calendar/calendar.module';
import { EMAIL_PROVIDER, emailProviderFactory } from '../members/invite-email';

import { CalendarEmailService } from './calendar-email.service';

/**
 * V11 B.S7 (D.38) — Calendar email module.
 *
 * Wires CalendarService (B.S6 pure-function ICS generator) and the
 * IEmailProvider (D.27 factory — FakeEmailProvider in dev, throws in
 * prod until Resend credential lands in Infisical) into the
 * `CalendarEmailService.sendInviteForTask()` call path.
 *
 * The EMAIL_PROVIDER provider here is intentionally a SECOND
 * registration alongside MembersModule's own. NestJS DI keys on the
 * token, and each module gets its own instance — FakeEmailProvider is
 * stateless (in-prod ResendEmailProvider wraps a stateless HTTP
 * client), so duplication is harmless and avoids forcing TasksModule
 * to transitively depend on MembersModule just for an email
 * provider. The factory is shared so both paths use the same prod
 * fail-fast behaviour.
 *
 * Exported so TasksModule can `@Inject` CalendarEmailService into
 * TasksService for the post-create / post-update / post-archive
 * best-effort hooks.
 */
@Module({
  imports: [CalendarModule],
  providers: [{ provide: EMAIL_PROVIDER, useFactory: emailProviderFactory }, CalendarEmailService],
  exports: [CalendarEmailService],
})
export class CalendarEmailModule {}
