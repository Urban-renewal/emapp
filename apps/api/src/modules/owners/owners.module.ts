import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { DataSubjectService } from './data-subject.service';
import { OwnerStatesController } from './owner-states.controller';
import { OwnerStatesService } from './owner-states.service';
import { OwnersController } from './owners.controller';
import { OwnersService } from './owners.service';

@Module({
  imports: [AuthModule],
  controllers: [OwnersController, OwnerStatesController],
  providers: [OwnersService, DataSubjectService, OwnerStatesService],
})
export class OwnersModule {}
