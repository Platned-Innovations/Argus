import { Body, Controller, type ExecutionContext, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  changePasswordSchema,
  type LoginResponse,
  loginSchema,
  type MeDto,
  mfaDisableSchema,
  type MfaEnableResponse,
  mfaEnableSchema,
  type MfaSetupResponse,
  mfaVerifySchema,
  signInLinkRequestSchema,
  signInLinkVerifySchema,
  type SignInOptionsDto,
} from '@argus/shared';
import { type Request, type Response } from 'express';
import { type z } from 'zod';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AppConfig } from '../config/app-config';
import { SettingsService } from '../core/settings.service';
import { toMeDto } from '../users/user.mapper';
import { AuthService, type LoginResult } from './auth.service';
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from './cookies';
import { SignInLinksService } from './sign-in-links.service';
import { AllowRestricted, CurrentUser, Public, SessionOnly, SkipCsrf } from './decorators';

export const AUTH_RATE_LIMIT_SETTING = 'argus.authRateLimit';

/** Credential-guessing endpoints get a much tighter per-IP rate limit than the API default (ARGUS_AUTH_RATE_LIMIT). */
export const STRICT_LIMIT = {
  default: {
    limit: (ctx: ExecutionContext) => (ctx.switchToHttp().getRequest<Request>().app.get(AUTH_RATE_LIMIT_SETTING) as number | undefined) ?? 10,
    ttl: 60_000,
  },
};

@Controller('auth')
@SessionOnly()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly signInLinks: SignInLinksService,
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  @SkipCsrf()
  @Throttle(STRICT_LIMIT)
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    return this.respond(await this.auth.login(body.username, body.password, requestContext(req)), res);
  }

  /** What the sign-in page may offer besides the password. */
  @Get('options')
  @Public()
  options(): Promise<SignInOptionsDto> {
    return this.signInLinks.options();
  }

  /** Emails a one-time sign-in link. The answer is the same whether or not the account exists. */
  @Post('sign-in-link')
  @HttpCode(200)
  @Public()
  @SkipCsrf()
  @Throttle(STRICT_LIMIT)
  async requestSignInLink(@Body(new ZodPipe(signInLinkRequestSchema)) body: z.infer<typeof signInLinkRequestSchema>, @Req() req: Request): Promise<{ ok: true }> {
    await this.signInLinks.request(body.login, requestContext(req));
    return { ok: true };
  }

  @Post('sign-in-link/verify')
  @HttpCode(200)
  @Public()
  @SkipCsrf()
  @Throttle(STRICT_LIMIT)
  async signInWithLink(@Body(new ZodPipe(signInLinkVerifySchema)) body: z.infer<typeof signInLinkVerifySchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    return this.respond(await this.signInLinks.signIn(body.token, requestContext(req)), res);
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @Public()
  @SkipCsrf()
  @Throttle(STRICT_LIMIT)
  async verifyMfa(@Body(new ZodPipe(mfaVerifySchema)) body: z.infer<typeof mfaVerifySchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    return this.respond(await this.auth.verifyMfaLogin(body.mfaToken, body.code, requestContext(req)), res);
  }

  @Post('refresh')
  @HttpCode(200)
  @Public()
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    try {
      const { tokens } = await this.auth.refresh(this.refreshCookie(req), requestContext(req));
      setAuthCookies(res, tokens, this.config.cookieSecure);
      return { ok: true };
    } catch (err) {
      clearAuthCookies(res, this.config.cookieSecure);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(200)
  @Public()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    await this.auth.logout(this.refreshCookie(req), requestContext(req));
    clearAuthCookies(res, this.config.cookieSecure);
    return { ok: true };
  }

  @Get('me')
  @AllowRestricted()
  async me(@CurrentUser() current: RequestUser): Promise<MeDto> {
    return toMeDto(current.user, await this.settings.getSecurity());
  }

  @Post('change-password')
  @HttpCode(200)
  @AllowRestricted()
  @Throttle(STRICT_LIMIT)
  async changePassword(
    @Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @CurrentUser() current: RequestUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeDto> {
    const { user, tokens } = await this.auth.changePassword(current.user, body.currentPassword, body.newPassword, requestContext(req));
    setAuthCookies(res, tokens, this.config.cookieSecure);
    return toMeDto(user, await this.settings.getSecurity());
  }

  @Post('mfa/setup')
  @HttpCode(200)
  @AllowRestricted()
  setupMfa(@CurrentUser() current: RequestUser): Promise<MfaSetupResponse> {
    return this.auth.beginMfaEnrollment(current.user);
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @AllowRestricted()
  @Throttle(STRICT_LIMIT)
  async enableMfa(@Body(new ZodPipe(mfaEnableSchema)) body: z.infer<typeof mfaEnableSchema>, @CurrentUser() current: RequestUser, @Req() req: Request): Promise<MfaEnableResponse> {
    return { recoveryCodes: await this.auth.confirmMfaEnrollment(current.user, body.code, requestContext(req)) };
  }

  @Post('mfa/disable')
  @HttpCode(200)
  @Throttle(STRICT_LIMIT)
  async disableMfa(@Body(new ZodPipe(mfaDisableSchema)) body: z.infer<typeof mfaDisableSchema>, @CurrentUser() current: RequestUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.auth.disableMfa(current.user, body.password, body.code, requestContext(req));
    return { ok: true };
  }

  private refreshCookie(req: Request): string | undefined {
    return (req.cookies as Record<string, string | undefined> | undefined)?.[REFRESH_COOKIE];
  }

  private async respond(result: LoginResult, res: Response): Promise<LoginResponse> {
    if (result.kind === 'mfa') return { status: 'mfa_required', mfaToken: result.mfaToken };
    setAuthCookies(res, result.tokens, this.config.cookieSecure);
    return { status: 'ok', user: toMeDto(result.user, await this.settings.getSecurity()) };
  }
}
