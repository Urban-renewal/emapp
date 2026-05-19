import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { BuildingsController } from './buildings.controller';
import { BuildingsService } from './buildings.service';

@Module({
  imports: [AuthModule],
  controllers: [BuildingsController],
  providers: [BuildingsService],
})
export class BuildingsModule {}
