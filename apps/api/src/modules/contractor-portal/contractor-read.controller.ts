import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

import { ContractorAuthGuard, type ContractorContext } from './contractor-auth.guard';
import { ContractorReadService } from './contractor-read.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * D2-DEF-1 / D.46 — contractor read-tier endpoints under `/contractor/*`.
 *
 * Gated SOLELY by `ContractorAuthGuard` (the share-access token) — there is
 * NO `@AuthzResource` / `AuthorizationGuard` here: a contractor is outside
 * the org POLICY matrix; authority is the share's JSONB perms, enforced
 * per-method in the service via the resolve-share helpers. Read-only.
 *
 * Throttled (60/min) — a leaked share link should not be enumerable at speed.
 */
@Controller('contractor')
@UseGuards(ContractorAuthGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class ContractorReadController {
  constructor(private readonly svc: ContractorReadService) {}

  private ctx(req: FastifyRequest): ContractorContext {
    return (req as FastifyRequest & { contractor: ContractorContext }).contractor;
  }

  @Get('project')
  async getProject(@Req() req: FastifyRequest) {
    return { data: await this.svc.getProject(this.ctx(req)) };
  }

  @Get('progress')
  async getProgress(@Req() req: FastifyRequest) {
    return { data: await this.svc.getProgress(this.ctx(req)) };
  }

  @Get('documents')
  async getDocuments(@Req() req: FastifyRequest) {
    return this.svc.getDocuments(this.ctx(req));
  }

  @Get('documents/:id/download')
  async download(@Req() req: FastifyRequest, @Param('id', UuidParam) id: string) {
    return { data: await this.svc.getDownloadUrl(this.ctx(req), id) };
  }
}
