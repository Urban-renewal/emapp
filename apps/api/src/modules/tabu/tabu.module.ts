import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { STORAGE_PROVIDER, storageProviderFactory } from '../documents/storage';

import { EXTRACTION_PROVIDER, extractionProviderFactory } from './extraction-provider.factory';
import { TabuExtractionsController } from './tabu-extractions.controller';
import { TabuExtractionsService } from './tabu-extractions.service';

// 7b-extract — TabuExtractionsService now reads source-doc bytes (STORAGE_PROVIDER,
// same governed factory as DocumentsModule) and parses them via a PLUGGABLE
// EXTRACTION_PROVIDER (default Stub — no external call, no PII leaves; real
// Gemini/Claude engine plugs in behind extractionProviderFactory). Both are the
// ISMSProvider-style DI-token + useFactory seam.
@Module({
  imports: [AuthModule],
  controllers: [TabuExtractionsController],
  providers: [
    TabuExtractionsService,
    { provide: STORAGE_PROVIDER, useFactory: storageProviderFactory },
    { provide: EXTRACTION_PROVIDER, useFactory: extractionProviderFactory },
  ],
})
export class TabuModule {}
