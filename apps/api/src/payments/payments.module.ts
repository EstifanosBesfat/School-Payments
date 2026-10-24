import { Module } from '@nestjs/common';
import { PaymentLockService } from './payment-lock.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PublicPayService } from './public-pay.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PublicPayService, PaymentLockService],
  exports: [PaymentsService, PaymentLockService],
})
export class PaymentsModule {}
