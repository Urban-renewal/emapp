import { Body, Controller, HttpCode, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
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

const REFRESH_PATH = '/api/v1/auth/refresh';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('signup')
  @HttpCode(201)
  @UsePipes(new ZodValidationPipe(SignupSchema))
  async signup(
    @Body() dto: SignupDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.signup(dto, ip, userAgent);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { data: { user: result.user } };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(LoginSchema))
  async login(
    @Body() dto: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.login(dto, ip, userAgent);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { data: { user: result.user } };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const refreshToken = (req.cookies as Record<string, string | undefined>)?.['refresh_token'];
    if (!refreshToken) {
      res.status(401);
      return { error: { code: 'missing_refresh_token' } };
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
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const refreshToken =
      (req.cookies as Record<string, string | undefined>)?.['refresh_token'] ?? '';
    await this.authService.logout(refreshToken, user.sub, user.orgId);
    res.clearCookie('access_token', this.authService.clearCookieOptions());
    res.clearCookie('refresh_token', {
      ...this.authService.clearCookieOptions(),
      path: REFRESH_PATH,
    });
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
    const result = await this.authService.switchOrg(user.sub, dto.org_id);
    res.setCookie('access_token', result.accessToken, this.authService.cookieOptions(15 * 60));
    return { data: { role: result.role } };
  }

  private setAuthCookies(res: FastifyReply, accessToken: string, refreshToken: string) {
    res.setCookie('access_token', accessToken, this.authService.cookieOptions(15 * 60));
    res.setCookie(
      'refresh_token',
      refreshToken,
      this.authService.cookieOptions(30 * 24 * 60 * 60, REFRESH_PATH),
    );
  }
}
