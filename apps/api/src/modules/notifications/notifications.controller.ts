import { ListNotificationsQuery, type ListNotificationsQueryDto } from '@emapp/shared-types';
import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { TenantScoped } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { NotificationsService } from './notifications.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Self-scoped (locked RLS user_id = app.user_id). Any authenticated org member
// manages ONLY their own notifications — this is NOT a role-permission surface,
// so every handler carries @TenantScoped (the NO_ENGINE_EQUIVALENT marker): the
// new catalog has no `notifications.*` permission by design. AuthGuard +
// TenantGuard prove an org member; RLS proves "own rows only". `read-all` is
// declared before `:id/read` so the static segment is not captured as an id.
@Controller('notifications')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @TenantScoped()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListNotificationsQuery)) query: ListNotificationsQueryDto,
  ) {
    return this.notifications.list(user, query);
  }

  // Audit M2-perf — dedicated unread-count for the Manager's bell.
  // FE polls every ~30s; without this they were fetching the full first
  // page just to count, blowing the budget for a hot tab. Constant-time
  // via the partial index `idx_notifications_user_unread`.
  // Declared BEFORE any `:id` routes so the static segment doesn't get
  // captured (cf. the `read-all` ordering comment at the top).
  @Get('unread-count')
  @TenantScoped()
  async unreadCount(@CurrentUser() user: AccessTokenPayload) {
    return { data: await this.notifications.unreadCount(user) };
  }

  @Post('read-all')
  @HttpCode(200)
  @TenantScoped() // mark-read is a self update — RLS self-scope, not a role permission
  async markAllRead(@CurrentUser() user: AccessTokenPayload) {
    return { data: await this.notifications.markAllRead(user) };
  }

  @Post(':id/read')
  @HttpCode(200)
  @TenantScoped() // mark-read is a self update — RLS self-scope, not a role permission
  async markRead(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.notifications.markRead(user, id) };
  }
}
