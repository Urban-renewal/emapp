import {
  CreateConversationInput,
  ListConversationsQuery,
  ListMessagesQuery,
  SendMessageInput,
  type CreateConversation,
  type ListConversationsQueryDto,
  type ListMessagesQueryDto,
  type SendMessage,
} from '@emapp/shared-types';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { MessagingService } from './messaging.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Team messaging: internal member ↔ member conversations. Authorization is
// PARTICIPATION-based (record-level), NOT the IAM capability matrix — so the
// controller carries AuthGuard (authenticated org member) + TenantGuard (org
// context) only; the participant boundary + viewer-read-only are enforced in
// the service (and by RLS). See migration 0075 + messaging.service.ts.
@Controller('conversations')
@UseGuards(AuthGuard, TenantGuard)
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListConversationsQuery)) query: ListConversationsQueryDto,
  ) {
    return this.messaging.list(user, query);
  }

  @Post()
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateConversationInput)) body: CreateConversation,
  ) {
    return { data: await this.messaging.create(user, body) };
  }

  @Get(':id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.messaging.get(user, id) };
  }

  @Get(':id/messages')
  async listMessages(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Query(new ZodValidationPipe(ListMessagesQuery)) query: ListMessagesQueryDto,
  ) {
    return this.messaging.listMessages(user, id, query);
  }

  @Post(':id/messages')
  async sendMessage(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(SendMessageInput)) body: SendMessage,
  ) {
    return { data: await this.messaging.sendMessage(user, id, body.body) };
  }

  @Post(':id/read')
  @HttpCode(204)
  async markRead(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.messaging.markRead(user, id);
  }
}
