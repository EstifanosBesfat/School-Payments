import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../common/decorators';
import { zodBody } from '../common/zod-validation.pipe';
import { GatewayRegistry } from './gateway.registry';

const completeSchema = z.object({
  outcome: z.enum(['success', 'failed']),
  method: z.enum(['telebirr', 'cbebirr', 'mpesa', 'card', 'bank']).default('telebirr'),
});

/** Development-only checkout simulator used by apps/web /dev/checkout/[txRef]. */
@ApiExcludeController()
@Controller('dev/mock-gateway')
export class MockGatewayController {
  constructor(private readonly gateways: GatewayRegistry) {}

  private gateway() {
    const gateway = this.gateways.mock();
    if (!gateway) throw new NotFoundException();
    return gateway;
  }

  @Public()
  @Get(':txRef')
  async describe(@Param('txRef') txRef: string) {
    const transaction = await this.gateway().describe(txRef);
    if (!transaction) throw new NotFoundException('Unknown transaction');
    return transaction;
  }

  @Public()
  @Post(':txRef/complete')
  async complete(@Param('txRef') txRef: string, @Body(zodBody(completeSchema)) body: z.infer<typeof completeSchema>) {
    return this.gateway().complete(txRef, body.outcome, body.method);
  }
}
