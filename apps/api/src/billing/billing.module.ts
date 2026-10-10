import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { FeeItemsService } from './fee-items.service';
import { InvoicesService } from './invoices.service';

@Module({
  controllers: [BillingController],
  providers: [FeeItemsService, InvoicesService],
  exports: [FeeItemsService, InvoicesService],
})
export class BillingModule {}
