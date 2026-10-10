import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [PaymentsModule, ReceiptsModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
})
export class ReconciliationModule {}
