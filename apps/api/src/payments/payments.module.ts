import { Module } from '@nestjs/common';
import { PaymentLockService } from './payment-lock.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentStatusController } from './payment-status.controller';
import { PublicPayService } from './public-pay.service';

@Module({
  controllers: [PaymentsController, PaymentStatusController],
  providers: [PaymentsService, PublicPayService, PaymentLockService],
  exports: [PaymentsService, PaymentLockService],
})
export class PaymentsModule {}
