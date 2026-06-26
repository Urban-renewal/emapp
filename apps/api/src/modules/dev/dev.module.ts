import { Module } from '@nestjs/common';

import { DevOutboxController } from './dev-outbox.controller';

/**
 * DEV-ONLY module. Registered by AppModule ONLY when
 * `NODE_ENV !== 'production'`, so the `/api/v1/dev/*` routes do not exist at all
 * in a deployed environment. Defense-in-depth: even if it were registered, every
 * handler hard-gates on `isDevAuthBypass()` (→ 404) and the shared dev outbox is
 * `null` in prod (the email factory throws before assigning it).
 */
@Module({ controllers: [DevOutboxController] })
export class DevModule {}
