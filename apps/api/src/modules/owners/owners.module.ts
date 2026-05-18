import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { OwnersController } from './owners.controller';
import { OwnersService } from './owners.service';

@Module({
  imports: [AuthModule],
  controllers: [OwnersController],
  providers: [OwnersService],
})
export class OwnersModule {}
