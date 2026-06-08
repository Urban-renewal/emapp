import { serverEnv } from '@emapp/config';
import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

import { AuthService } from './auth.service';
import type { AccessTokenPayload } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { LoginSchema, OrgSwitchSchema } from './dto/login.dto';
import type { LoginDto, OrgSwitchDto } from './dto/login.dto';
import { SignupSchema } from './dto/signup.dto';
import type { SignupDto } from './dto/signup.dto';
import { AuthGuard } from './guards/auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Client-controlled, untrusted: bound the length before it reaches the DB
  // (audit_log / auth_sessions) to prevent log-bloat / storage DoS.
  private ua(req: FastifyRequest): string | undefined {
    const v = req.headers['user-agent'];
    return v ? v.slice(0, 512) : undefined;
  }

  private setAuthCookies(res: FastifyReply, accessToken: string, refreshToken: string) {
    const c = this.authService.cookies(accessToken, refreshToken);
    res.setCookie(c.access.name, c.access.value, c.access.opts);
    res.setCookie(c.refresh.name, c.refresh.value, c.refresh.opts);
  }

  @Public()
  // Tight per-route limit: signup does a ~50ms argon2 hash + a privileged
  // BYPASSRLS pooled connection — the global 100/min is far too loose for an
  // unauthenticated endpoint. 5 / 10 min / IP.
  @Throttle({ default: { limit: 5, ttl: 600000 } })
  @Post('signup')
  @HttpCode(201)
  @UsePipes(new ZodValidationPipe(SignupSchema))
  async signup(
    @Body() dto: SignupDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    // Public self-service signup is INACTIVE by default (owner-approved, refines
    // D.21 — the active onboarding path is provider-led). When the flag is off,
    // the route behaves as if it does not exist: a 404 BEFORE any work (no
    // argon2 hash, no DB, no privileged connection). Flip PUBLIC_SIGNUP_ENABLED
    // to '1' to fully restore the original behavior. The service method, DTO,
    // and D.21 `withBootstrap` are all retained — just unreachable while off.
    // See docs/decision-records/disable-public-signup.md.
    if (serverEnv.PUBLIC_SIGNUP_ENABLED !== '1') {
      throw new NotFoundException();
    }
    const result = await this.authService.signup(dto, req.ip, this.ua(req));
    // Anti-enumeration (D.14): duplicate email returns the SAME 201 status
    // with a neutral body — no email_taken / 409 / existence leak.
    if ('duplicate' in result) {
      return { data: { ok: true } };
    }
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { data: { user: result.user } };
  }

  @Public()
  // Per-IP volumetric brake (account lockout is the per-account control and
  // is intentionally SILENT). 10 / min / IP — a 429 here is NOT an
  // enumeration oracle (fires regardless of whether the account exists).
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(LoginSchema))
  async login(
    @Body() dto: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const result = await this.authService.login(dto, req.ip, this.ua(req));
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { data: { user: result.user } };
  }

  // Audit M-5 fix — per-route throttle on /refresh.
  // The global 100/min/IP budget is shared with every other endpoint on
  // the same IP; a single misbehaving FE tab in a stuck refresh loop
  // could chew through that and self-DoS the manager's whole network.
  // 30/min/IP is generous for legitimate rotation (clients refresh once
  // per ~15 min) but blocks runaway loops at the route level. Stricter
  // than `login`'s 10/min — refresh is invoked transparently on every
  // page load + xhr.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const refreshToken = (req.cookies as Record<string, string | undefined>)?.['refresh_token'];
    if (!refreshToken) {
      res.status(401);
      return { error: { code: 'missing_refresh_token', message: 'No refresh token' } };
    }
    const result = await this.authService.refresh(refreshToken);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { data: { ok: true } };
  }

  @UseGuards(AuthGuard)
  @Post('logout')
  @HttpCode(200)
  async logout(
    @CurrentUser() user: AccessTokenPayload,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    await this.authService.logout(user.sub, user.orgId);
    res.clearCookie('access_token', this.authService.clearCookieOpts('/'));
    res.clearCookie('refresh_token', this.authService.clearCookieOpts('/api/v1/auth/refresh'));
    return { data: { ok: true } };
  }

  @UseGuards(AuthGuard)
  @Post('switch-org')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(OrgSwitchSchema))
  async switchOrg(
    @Body() dto: OrgSwitchDto,
    @CurrentUser() user: AccessTokenPayload,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const result = await this.authService.switchOrg(user.sub, dto.org_id, user.sid);
    const c = this.authService.cookies(result.accessToken, '');
    res.setCookie(c.access.name, c.access.value, c.access.opts);
    return { data: { role: result.role } };
  }
}
