import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type LoginInput, loginSchema, refreshSchema, totpCodeSchema } from '@payment/shared';
import type { z } from 'zod';
import { AllowDuringMfaSetup, ClientIp, CurrentPrincipal, Public } from '../common/decorators';
import type { Principal, UserPrincipal } from '../common/principal';
import { zodBody } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';

function requireUser(principal: Principal | undefined): UserPrincipal {
  if (principal?.type !== 'user') throw new ForbiddenException();
  return principal;
}

@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(
    @Body(zodBody(loginSchema)) body: LoginInput,
    @ClientIp() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.auth.login(body, { ip, userAgent });
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Body(zodBody(refreshSchema)) body: z.infer<typeof refreshSchema>,
    @ClientIp() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.auth.refresh(body.refreshToken, { ip, userAgent });
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body(zodBody(refreshSchema)) body: z.infer<typeof refreshSchema>) {
    await this.auth.logout(body.refreshToken);
  }

  @AllowDuringMfaSetup()
  @Get('me')
  me(@CurrentPrincipal() principal: Principal) {
    return this.auth.me(requireUser(principal).userId);
  }

  @AllowDuringMfaSetup()
  @Post('2fa/setup')
  @HttpCode(200)
  setupTotp(@CurrentPrincipal() principal: Principal) {
    return this.auth.beginTotpSetup(requireUser(principal).userId);
  }

  @AllowDuringMfaSetup()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('2fa/enable')
  @HttpCode(200)
  enableTotp(
    @CurrentPrincipal() principal: Principal,
    @Body(zodBody(totpCodeSchema)) body: z.infer<typeof totpCodeSchema>,
    @ClientIp() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.auth.enableTotp(requireUser(principal).userId, body.code, { ip, userAgent });
  }
}
