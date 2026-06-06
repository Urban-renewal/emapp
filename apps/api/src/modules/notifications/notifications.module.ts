import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { NotificationsProducerService } from './notifications-producer.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsProducerService],
  // Exported so other domains (signatures, documents, …) can generate
  // in-app notifications without re-implementing the RLS-scoped insert.
  exports: [NotificationsProducerService],
})
export class NotificationsModule {}
