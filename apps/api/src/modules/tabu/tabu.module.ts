import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { TabuExtractionsController } from './tabu-extractions.controller';
import { TabuExtractionsService } from './tabu-extractions.service';

@Module({
  imports: [AuthModule],
  controllers: [TabuExtractionsController],
  providers: [TabuExtractionsService],
})
export class TabuModule {}
