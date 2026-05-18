import { ListNotificationsQuery, type ListNotificationsQueryDto } from '@emapp/shared-types';
import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { NotificationsService } from './notifications.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Self-scoped (locked RLS user_id = app.user_id). Any org role manages
// only their own notifications. `read-all` is declared before `:id/read`
// so the static segment is not captured as an id.
@Controller('notifications')
@UseGuards(AuthGuard, TenantGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListNotificationsQuery)) query: ListNotificationsQueryDto,
  ) {
    return this.notifications.list(user, query);
  }

  @Post('read-all')
  @HttpCode(200)
  async markAllRead(@CurrentUser() user: AccessTokenPayload) {
    return { data: await this.notifications.markAllRead(user) };
  }

  @Post(':id/read')
  @HttpCode(200)
  async markRead(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.notifications.markRead(user, id) };
  }
}
