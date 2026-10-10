import { Controller, Get, Header, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { isoDateSchema, paginationSchema, receiptLookupSchema } from '@payment/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiKeyScopes, CurrentPrincipal, Public, Roles } from '../common/decorators';
import { type Principal, requireSchoolId } from '../common/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReceiptsService } from './receipts.service';

const listQuery = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
const exportQuery = z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() });

function dayStart(value?: string): Date | undefined {
  return value ? new Date(`${value}T00:00:00+03:00`) : undefined;
}

function dayEnd(value?: string): Date | undefined {
  const start = dayStart(value);
  return start ? new Date(start.getTime() + 24 * 3600 * 1000) : undefined;
}

function sendPdf(res: Response, filename: string, pdf: Buffer, inline: boolean): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^A-Za-z0-9_.-]/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  res.send(pdf);
}

@ApiTags('receipts')
@Controller()
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Public()
  @SkipThrottle()
  @Get('.well-known/receipt-keys.json')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({ summary: 'Public Ed25519 keys used to sign receipts' })
  keys() {
    return this.receipts.publicKeys();
  }

  @Public()
  @Get('receipts/offline-verifier.html')
  @ApiOperation({ summary: 'Download a self-contained HTML page that verifies receipts with no network' })
  offlineVerifier(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="receipt-verifier.html"');
    res.send(this.receipts.offlineVerifierHtml());
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('receipts/lookup')
  @ApiOperation({ summary: 'Look up a receipt by its number and verification code' })
  lookup(@Query(new ZodValidationPipe(receiptLookupSchema)) query: z.infer<typeof receiptLookupSchema>) {
    return this.receipts.lookup(query.receiptNo, query.code);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('receipts/lookup/pdf')
  async lookupPdf(@Query(new ZodValidationPipe(receiptLookupSchema)) query: z.infer<typeof receiptLookupSchema>, @Res() res: Response) {
    const receipt = await this.receipts.findByNumberAndCode(query.receiptNo, query.code);
    sendPdf(res, `${receipt.receiptNo}.pdf`, await this.receipts.pdf(receipt), true);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('pay/:token/receipts/:receiptId/pdf')
  async payTokenPdf(@Param('token') token: string, @Param('receiptId') receiptId: string, @Res() res: Response) {
    const receipt = await this.receipts.receiptForPayToken(token, receiptId);
    sendPdf(res, `${receipt.receiptNo}.pdf`, await this.receipts.pdf(receipt), true);
  }

  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('receipts:read')
  @Get('receipts')
  list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.receipts.list(requireSchoolId(principal), { page: query.page, pageSize: query.pageSize, search: query.search, from: dayStart(query.from), to: dayEnd(query.to) });
  }

  @ApiBearerAuth()
  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @Get('receipts/export.csv')
  async exportCsv(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(exportQuery)) query: z.infer<typeof exportQuery>, @Res() res: Response) {
    const csv = await this.receipts.exportCsv(requireSchoolId(principal), dayStart(query.from), dayEnd(query.to));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="receipts-${query.from ?? 'all'}-${query.to ?? 'now'}.csv"`);
    res.send(`\uFEFF${csv}`);
  }

  @ApiBearerAuth()
  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @Post('receipts/chain/verify')
  @ApiOperation({ summary: 'Recompute hashes, links and signatures of every receipt of the school' })
  verifyChain(@CurrentPrincipal() principal: Principal) {
    return this.receipts.verifyChain(requireSchoolId(principal));
  }

  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('receipts:read')
  @Get('receipts/:id')
  async get(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    const receipt = await this.receipts.getForSchool(requireSchoolId(principal), id);
    return { ...receipt, qr: this.receipts.qrContent(receipt) };
  }

  @ApiBearerAuth()
  @ApiSecurity('api-key')
  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('receipts:read')
  @Get('receipts/:id/pdf')
  async pdf(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Res() res: Response) {
    const receipt = await this.receipts.getForSchool(requireSchoolId(principal), id);
    sendPdf(res, `${receipt.receiptNo}.pdf`, await this.receipts.pdf(receipt), false);
  }
}
