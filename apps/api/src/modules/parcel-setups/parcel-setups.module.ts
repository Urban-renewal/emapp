import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { PARCEL_DATA_PROVIDER, parcelDataProviderFactory } from './parcel-data-provider.factory';
import { ParcelSetupsController } from './parcel-setups.controller';
import { ParcelSetupsService } from './parcel-setups.service';

// P3a — parcel-setup envelope + manual path → skeleton.
// P3b — the service now consults a PLUGGABLE parcel-data provider on create
// (default: zero-egress Stub → manual path; PARCEL_LOOKUP_ENABLED='true' →
// LocalMapi over the bulk-מפ"י parcel_lookup table). Same ISMSProvider-style
// DI-token + useFactory seam as EXTRACTION_PROVIDER (tabu module).
@Module({
  imports: [AuthModule],
  controllers: [ParcelSetupsController],
  providers: [
    ParcelSetupsService,
    { provide: PARCEL_DATA_PROVIDER, useFactory: parcelDataProviderFactory },
  ],
})
export class ParcelSetupsModule {}
