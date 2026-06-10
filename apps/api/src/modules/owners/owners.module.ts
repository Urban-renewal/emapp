import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { DataSubjectService } from './data-subject.service';
import { OwnersController } from './owners.controller';
import { OwnersService } from './owners.service';

@Module({
  imports: [AuthModule],
  controllers: [OwnersController],
  providers: [OwnersService, DataSubjectService],
})
export class OwnersModule {}
