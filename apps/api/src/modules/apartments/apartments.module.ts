import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { ApartmentStatesController } from './apartment-states.controller';
import { ApartmentStatesService } from './apartment-states.service';
import { ApartmentsController } from './apartments.controller';
import { ApartmentsService } from './apartments.service';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [ApartmentsController, ApartmentStatesController],
  providers: [ApartmentsService, ApartmentStatesService],
})
export class ApartmentsModule {}
