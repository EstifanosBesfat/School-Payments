import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PublicPayService } from './public-pay.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PublicPayService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
