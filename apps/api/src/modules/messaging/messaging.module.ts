import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';

@Module({
  imports: [AuthModule],
  controllers: [MessagingController],
  providers: [MessagingService],
})
export class MessagingModule {}
