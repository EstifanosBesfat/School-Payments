import { Body, Controller, ForbiddenException, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { phoneSchema } from '@payment/shared';
import { z } from 'zod';
import { CurrentPrincipal, Public, Roles } from '../common/decorators';
import type { Principal } from '../common/principal';
import { zodBody } from '../common/zod-validation.pipe';
import { ParentsService } from './parents.service';

const requestSchema = z.object({ phone: phoneSchema });
const verifySchema = z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

@ApiTags('parents')
@Controller('parent')
export class ParentsController {
  constructor(private readonly parents: ParentsService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @Post('otp/request')
  @HttpCode(202)
  request(@Body(zodBody(requestSchema)) body: z.infer<typeof requestSchema>) {
    return this.parents.requestOtp(body.phone);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 15 * 60_000 } })
  @Post('otp/verify')
  @HttpCode(200)
  verify(@Body(zodBody(verifySchema)) body: z.infer<typeof verifySchema>) {
    return this.parents.verifyOtp(body.phone, body.code);
  }

  @ApiBearerAuth()
  @Roles('PARENT')
  @Get('overview')
  overview(@CurrentPrincipal() principal: Principal) {
    if (principal.type !== 'parent') throw new ForbiddenException();
    return this.parents.overview(principal.phone);
  }
}
