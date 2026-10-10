import { Global, Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import { WebhookEndpointsService } from './webhook-endpoints.service';

@Global()
@Module({
  controllers: [IntegrationsController],
  providers: [OutboundWebhooksService, WebhookEndpointsService],
  exports: [OutboundWebhooksService],
})
export class IntegrationsModule {}
