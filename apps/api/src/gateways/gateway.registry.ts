import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { QueueService } from '../queue/queue.service';
import { ChapaGateway } from './chapa.gateway';
import { ArifPayGateway } from './arifpay.gateway';
import { MockGateway } from './mock.gateway';
import type { PaymentGateway } from './payment-gateway.interface';

@Injectable()
export class GatewayRegistry {
  private readonly gateways = new Map<string, PaymentGateway>();
  readonly defaultGatewayName: string;

  constructor(@Inject(APP_ENV) env: AppEnv, queues: QueueService) {
    if (env.CHAPA_SECRET_KEY && env.CHAPA_WEBHOOK_SECRET) {
      this.gateways.set(
        'chapa',
        new ChapaGateway({
          baseUrl: env.CHAPA_BASE_URL,
          secretKey: env.CHAPA_SECRET_KEY,
          webhookSecret: env.CHAPA_WEBHOOK_SECRET,
        }),
      );
    }
    if (env.ARIFPAY_API_KEY) {
      this.gateways.set(
        'arifpay',
        new ArifPayGateway({
          baseUrl: env.ARIFPAY_BASE_URL,
          apiKey: env.ARIFPAY_API_KEY,
          sandbox: env.ARIFPAY_SANDBOX,
        }),
      );
    }
    if (env.NODE_ENV !== 'production') {
      this.gateways.set(
        'mock',
        new MockGateway(queues.connection, {
          webUrl: env.WEB_URL,
          apiUrl: env.API_PUBLIC_URL,
          webhookSecret: env.CHAPA_WEBHOOK_SECRET ?? 'mock-webhook-secret',
        }),
      );
    }
    this.defaultGatewayName = env.PAYMENT_GATEWAY;
    if (!this.gateways.has(this.defaultGatewayName)) {
      throw new Error(`Payment gateway "${this.defaultGatewayName}" is not configured`);
    }
  }

  get(name: string): PaymentGateway {
    const gateway = this.gateways.get(name);
    if (!gateway) throw new NotFoundException(`Payment gateway ${name} is not enabled`);
    return gateway;
  }

  default(): PaymentGateway {
    return this.get(this.defaultGatewayName);
  }

  mock(): MockGateway | null {
    const gateway = this.gateways.get('mock');
    return gateway instanceof MockGateway ? gateway : null;
  }

  names(): string[] {
    return [...this.gateways.keys()];
  }
}
