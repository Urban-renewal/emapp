import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CalendarEmailModule } from '../calendar-email/calendar-email.module';

import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  // V11 B.S7 (D.38) — TasksService fires best-effort calendar invites
  // after create/update/archive via the injected CalendarEmailService.
  imports: [AuthModule, CalendarEmailModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
