import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  type BulkInvoiceInput,
  bulkInvoiceSchema,
  type CreateFeeItemInput,
  createFeeItemSchema,
  type CreateInvoiceInput,
  createInvoiceSchema,
  INVOICE_STATUSES,
  paginationSchema,
  santimSchema,
} from '@payment/shared';
import { z } from 'zod';
import { ApiKeyScopes, CurrentPrincipal, Roles } from '../common/decorators';
import { Idempotent } from '../common/idempotency.interceptor';
import { type Principal, requireSchoolId } from '../common/principal';
import { ZodValidationPipe, zodBody } from '../common/zod-validation.pipe';
import { FeeItemsService } from './fee-items.service';
import { InvoicesService } from './invoices.service';

const feeListQuery = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
const updateFeeItemSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  amount: santimSchema.optional(),
  isActive: z.boolean().optional(),
});
const invoiceListQuery = paginationSchema.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
  studentId: z.string().optional(),
  term: z.string().trim().max(50).optional(),
  search: z.string().trim().max(100).optional(),
  overdue: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });

@ApiTags('billing')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller()
export class BillingController {
  constructor(
    private readonly feeItems: FeeItemsService,
    private readonly invoices: InvoicesService,
  ) {}

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('invoices:read')
  @Get('fee-items')
  listFeeItems(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(feeListQuery)) query: z.infer<typeof feeListQuery>) {
    return this.feeItems.list(requireSchoolId(principal), query.includeInactive);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @Post('fee-items')
  createFeeItem(@CurrentPrincipal() principal: Principal, @Body(zodBody(createFeeItemSchema)) body: CreateFeeItemInput) {
    return this.feeItems.create(requireSchoolId(principal), body, principal);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @Patch('fee-items/:id')
  updateFeeItem(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(zodBody(updateFeeItemSchema)) body: z.infer<typeof updateFeeItemSchema>) {
    return this.feeItems.update(requireSchoolId(principal), id, body, principal);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('invoices:read')
  @Get('invoices')
  listInvoices(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(invoiceListQuery)) query: z.infer<typeof invoiceListQuery>) {
    return this.invoices.list(requireSchoolId(principal), query);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('invoices:read')
  @Get('invoices/:id')
  getInvoice(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.invoices.get(requireSchoolId(principal), id);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('invoices:write')
  @Idempotent()
  @Post('invoices')
  createInvoice(@CurrentPrincipal() principal: Principal, @Body(zodBody(createInvoiceSchema)) body: CreateInvoiceInput) {
    return this.invoices.create(requireSchoolId(principal), body, principal);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('invoices:write')
  @Idempotent()
  @Post('invoices/bulk')
  createBulk(@CurrentPrincipal() principal: Principal, @Body(zodBody(bulkInvoiceSchema)) body: BulkInvoiceInput) {
    return this.invoices.createBulk(requireSchoolId(principal), body, principal);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('invoices:write')
  @Post('invoices/:id/cancel')
  cancel(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(zodBody(cancelSchema)) body: z.infer<typeof cancelSchema>) {
    return this.invoices.cancel(requireSchoolId(principal), id, body.reason, principal);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @Post('invoices/:id/remind')
  remind(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.invoices.remind(requireSchoolId(principal), id, principal);
  }
}
