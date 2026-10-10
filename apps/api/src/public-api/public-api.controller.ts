import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { invoiceLineSchema, isoDateSchema } from '@payment/shared';
import { z } from 'zod';
import { ApiKeyScopes, CurrentPrincipal, Roles } from '../common/decorators';
import { Idempotent } from '../common/idempotency.interceptor';
import { type Principal, requireSchoolId } from '../common/principal';
import { zodBody } from '../common/zod-validation.pipe';
import { PublicApiService } from './public-api.service';

const createInvoiceByCodeSchema = z.object({
  studentCode: z.string().trim().min(1).max(50),
  term: z.string().trim().max(50).optional(),
  dueDate: isoDateSchema,
  lines: z.array(invoiceLineSchema).min(1).max(50),
  notify: z.boolean().default(true),
});

@ApiTags('v1 (integrations)')
@ApiSecurity('api-key')
@Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
@Controller('v1')
export class PublicApiController {
  constructor(private readonly api: PublicApiService) {}

  @ApiKeyScopes('students:read', 'invoices:read')
  @Get('students/:code/balance')
  @ApiOperation({ summary: 'Outstanding balance and open invoices (with pay links) for a student code' })
  balance(@CurrentPrincipal() principal: Principal, @Param('code') code: string) {
    return this.api.studentBalance(requireSchoolId(principal), code);
  }

  @ApiKeyScopes('invoices:write')
  @Idempotent()
  @Post('invoices')
  @ApiOperation({ summary: 'Create an invoice for a student code; send Idempotency-Key to make retries safe' })
  createInvoice(@CurrentPrincipal() principal: Principal, @Body(zodBody(createInvoiceByCodeSchema)) body: z.infer<typeof createInvoiceByCodeSchema>) {
    return this.api.createInvoice(requireSchoolId(principal), body, principal);
  }

  @ApiKeyScopes('invoices:read')
  @Get('invoices/:number')
  invoice(@CurrentPrincipal() principal: Principal, @Param('number') number: string) {
    return this.api.invoiceView(requireSchoolId(principal), number);
  }

  @ApiKeyScopes('payments:read')
  @Get('payments/:txRef')
  payment(@CurrentPrincipal() principal: Principal, @Param('txRef') txRef: string) {
    return this.api.payment(requireSchoolId(principal), txRef);
  }

  @ApiKeyScopes('receipts:read')
  @Get('receipts/:receiptNo')
  @ApiOperation({ summary: 'Signed receipt payload, signature and QR content' })
  receipt(@CurrentPrincipal() principal: Principal, @Param('receiptNo') receiptNo: string) {
    return this.api.receipt(requireSchoolId(principal), receiptNo);
  }
}
