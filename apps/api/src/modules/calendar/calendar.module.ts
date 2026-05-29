import { Module } from '@nestjs/common';

import { CalendarService } from './calendar.service';

/**
 * V11 B.S6 — Calendar / ICS generator (D.38).
 *
 * Pure-function service, no DI dependencies, no controllers. B.S7
 * (Resend integration) imports CalendarService and feeds it task +
 * attendee data from the DB. Future B.S10 export endpoint may also
 * consume CalendarService for the .ics-as-attachment download path.
 *
 * Exported so other modules can `@Inject` CalendarService without
 * each one duplicating its construction.
 */
@Module({
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
