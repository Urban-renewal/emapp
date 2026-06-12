import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ParcelSetupsController } from './parcel-setups.controller';
import { ParcelSetupsService } from './parcel-setups.service';

// P3a — parcel-setup envelope + manual path → skeleton. MANUAL-only this
// slice: the service has NO constructor deps (the IParcelDataProvider seam +
// Stub arrive in P3b behind a DI token, mirroring EXTRACTION_PROVIDER).
@Module({
  imports: [AuthModule],
  controllers: [ParcelSetupsController],
  providers: [ParcelSetupsService],
})
export class ParcelSetupsModule {}
