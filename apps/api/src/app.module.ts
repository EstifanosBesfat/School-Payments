import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { RedisThrottlerStorage } from './common/redis-throttler.storage';
import { ConfigModule } from './config/config.module';
import { GatewaysModule } from './gateways/gateways.module';
import { HealthController } from './health/health.controller';
import { IntegrationsModule } from './integrations/integrations.module';
import { LedgerModule } from './ledger/ledger.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { QueueService } from './queue/queue.service';
import { BillingModule } from './billing/billing.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ParentsModule } from './parents/parents.module';
import { PublicApiModule } from './public-api/public-api.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { ReceiptsModule } from './receipts/receipts.module';
import { StorageModule } from './storage/storage.module';
import { StudentsModule } from './students/students.module';
import { TenantsModule } from './tenants/tenants.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule,
    CommonModule,
    PrismaModule,
    QueueModule,
    ThrottlerModule.forRootAsync({
      inject: [QueueService],
      useFactory: (queues: QueueService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
        storage: new RedisThrottlerStorage(queues.connection),
      }),
    }),
    AuditModule,
    AuthModule,
    GatewaysModule,
    LedgerModule,
    IntegrationsModule,
    StorageModule,
    NotificationsModule,
    TenantsModule,
    StudentsModule,
    BillingModule,
    PaymentsModule,
    WebhooksModule,
    ReceiptsModule,
    ParentsModule,
    PublicApiModule,
    ReconciliationModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
