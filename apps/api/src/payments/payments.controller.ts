import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { paginationSchema, PAYMENT_STATUSES, type StartPaymentInput, type StartPaymentResult, startPaymentSchema } from '@payment/shared';
import { z } from 'zod';
import { ApiKeyScopes, ClientIp, CurrentPrincipal, Public, Roles } from '../common/decorators';
import { Idempotent } from '../common/idempotency.interceptor';
import { type Principal, requireSchoolId } from '../common/principal';
import { ZodValidationPipe, zodBody } from '../common/zod-validation.pipe';
import { PaymentsService } from './payments.service';
import { PublicPayService } from './public-pay.service';

const listQuerySchema = paginationSchema.extend({ status: z.enum(PAYMENT_STATUSES).optional() });
const callbackQuerySchema = z.object({
  trx_ref: z.string().min(3).max(100).optional(),
  tx_ref: z.string().min(3).max(100).optional(),
});

@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly publicPay: PublicPayService,
  ) {}

  @Public()
  @Get('pay/:token')
  @ApiOperation({ summary: 'Public invoice summary for the pay link sent by SMS' })
  view(@Param('token') token: string) {
    return this.publicPay.view(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Idempotent()
  @Post('pay/:token/start')
  @ApiOperation({ summary: 'Start a payment' })
  start(
    @Param('token') token: string,
    @Body(zodBody(startPaymentSchema)) body: StartPaymentInput,
    @ClientIp() ip: string | undefined,
  ): Promise<StartPaymentResult> {
    return this.payments.start(token, body, ip);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('pay/:token/status')
  status(@Param('token') token: string, @Query('tx') txRef: string) {
    return this.publicPay.status(token, txRef);
  }

  /** Chapa calls callback_url with GET ?trx_ref=...&status=...; never trusted, only triggers verify. */
  @Public()
  @Get('payments/callback/:gateway')
  @HttpCode(200)
  async callback(@Query(new ZodValidationPipe(callbackQuerySchema)) query: z.infer<typeof callbackQuerySchema>) {
    const txRef = query.trx_ref ?? query.tx_ref;
    if (txRef) await this.payments.enqueueVerification(txRef, 'callback');
    return { received: true };
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('payments:read')
  @Get('payments')
  list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>) {
    return this.payments.listForSchool(requireSchoolId(principal), query);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('payments:read')
  @Get('payments/:id')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.payments.getForSchool(requireSchoolId(principal), id);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @Post('payments/:id/verify')
  @ApiOperation({ summary: 'Re-check a payment with the gateway now' })
  async verify(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    const payment = await this.payments.getForSchool(requireSchoolId(principal), id);
    const outcome = await this.payments.verifyAndSettle(payment.txRef, 'manual');
    return { outcome };
  }
}
