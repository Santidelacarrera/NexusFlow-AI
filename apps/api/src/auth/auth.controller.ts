import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { getEnv } from '../common/config/env';
import { Client, CurrentUser, Public } from '../common/http/decorators';
import type { AuthUser, ClientInfo } from '../common/http/types';
import { zod } from '../common/http/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuthService,
  changePasswordSchema,
  loginSchema,
  REFRESH_TTL_MS,
  registerSchema,
  type SessionResult,
} from './auth.service';
import { Cron } from '@nestjs/schedule';

const COOKIE = 'nf_rt';
const COOKIE_PATH = '/api/auth';

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: getEnv().NODE_ENV === 'production',
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: REFRESH_TTL_MS,
  });
}

function publicSession({ refreshToken: _omit, ...rest }: SessionResult) {
  return rest;
}

/** Defensa en profundidad contra CSRF en endpoints basados en cookie: el Origin debe estar en la lista permitida. */
function assertTrustedOrigin(req: Request): void {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('Origen no permitido');
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = getEnv()
    .CORS_ORIGINS.split(',')
    .map((o) => o.trim());
  if (!allowed.includes(origin)) throw new ForbiddenException('Origen no permitido');
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body(zod(registerSchema)) dto: ReturnType<typeof registerSchema.parse>,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
  ) {
    assertTrustedOrigin(req);
    const session = await this.auth.register(dto, client);
    setRefreshCookie(res, session.refreshToken);
    return publicSession(session);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body(zod(loginSchema)) dto: ReturnType<typeof loginSchema.parse>,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
  ) {
    assertTrustedOrigin(req);
    const session = await this.auth.login(dto, client);
    setRefreshCookie(res, session.refreshToken);
    return publicSession(session);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertTrustedOrigin(req);
    try {
      const session = await this.auth.refresh(req.cookies?.[COOKIE], client);
      setRefreshCookie(res, session.refreshToken);
      return publicSession(session);
    } catch (err) {
      res.clearCookie(COOKIE, { path: COOKIE_PATH });
      throw err;
    }
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Req() req: Request, @Client() client: ClientInfo, @Res({ passthrough: true }) res: Response) {
    assertTrustedOrigin(req);
    await this.auth.logout(req.cookies?.[COOKIE], client);
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
  }

  @HttpCode(204)
  @Post('logout-all')
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logoutAll(user.id, user.orgId, client);
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(204)
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body(zod(changePasswordSchema)) dto: ReturnType<typeof changePasswordSchema.parse>,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.changePassword(user.id, dto, client);
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: user.orgId },
      select: { name: true, plan: true, currency: true },
    });
    return { ...user, orgName: org.name, plan: org.plan, currency: org.currency };
  }
}

@Injectable()
export class TokenCleanup {
  constructor(private readonly auth: AuthService) {}
  @Cron('0 3 * * *')
  async run() {
    await this.auth.purgeExpiredTokens();
  }
}

@Module({ controllers: [AuthController], providers: [AuthService, TokenCleanup], exports: [AuthService] })
export class AuthModule {}
