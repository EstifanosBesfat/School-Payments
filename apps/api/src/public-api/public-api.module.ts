import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';

@Module({
  imports: [BillingModule, ReceiptsModule],
  controllers: [PublicApiController],
  providers: [PublicApiService],
})
export class PublicApiModule {}
