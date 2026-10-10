import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateWebhookEndpointInput } from '@payment/shared';
import { AuditService } from '../audit/audit.service';
import { randomToken, SecretBox } from '../common/crypto.util';
import type { Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { JOBS, QUEUES } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { OutboundWebhooksService } from './outbound-webhooks.service';

const ENDPOINT_FIELDS = { id: true, url: true, events: true, isActive: true, createdAt: true, updatedAt: true } as const;

@Injectable()
export class WebhookEndpointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
    private readonly outbound: OutboundWebhooksService,
    private readonly queues: QueueService,
  ) {}

  list(schoolId: string) {
    return this.prisma.tenant(schoolId, (tx) => tx.webhookEndpoint.findMany({ where: { schoolId }, orderBy: { createdAt: 'desc' }, select: ENDPOINT_FIELDS }));
  }

  /** The signing secret is returned once; it is stored encrypted (it must be recoverable to sign). */
  async create(schoolId: string, input: CreateWebhookEndpointInput, principal: Principal) {
    try {
      await this.outbound.assertSafeUrl(input.url);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const secret = `whsec_${randomToken(32)}`;
    const endpoint = await this.prisma.tenant(schoolId, async (tx) => {
      const created = await tx.webhookEndpoint.create({
        data: { schoolId, url: input.url, events: input.events, secretEncrypted: this.secrets.encrypt(secret) },
        select: ENDPOINT_FIELDS,
      });
      await this.audit.record({ schoolId, principal, action: 'webhook_endpoint.created', entityType: 'WebhookEndpoint', entityId: created.id, metadata: { url: input.url, events: input.events } }, tx);
      return created;
    });
    return { ...endpoint, secret };
  }

  async setActive(schoolId: string, id: string, isActive: boolean, principal: Principal) {
    return this.prisma.tenant(schoolId, async (tx) => {
      const existing = await tx.webhookEndpoint.findFirst({ where: { id, schoolId } });
      if (!existing) throw new NotFoundException('Webhook endpoint not found');
      const updated = await tx.webhookEndpoint.update({ where: { id }, data: { isActive }, select: ENDPOINT_FIELDS });
      await this.audit.record({ schoolId, principal, action: isActive ? 'webhook_endpoint.enabled' : 'webhook_endpoint.disabled', entityType: 'WebhookEndpoint', entityId: id }, tx);
      return updated;
    });
  }

  async rotateSecret(schoolId: string, id: string, principal: Principal) {
    const secret = `whsec_${randomToken(32)}`;
    await this.prisma.tenant(schoolId, async (tx) => {
      const result = await tx.webhookEndpoint.updateMany({ where: { id, schoolId }, data: { secretEncrypted: this.secrets.encrypt(secret) } });
      if (result.count === 0) throw new NotFoundException('Webhook endpoint not found');
      await this.audit.record({ schoolId, principal, action: 'webhook_endpoint.secret_rotated', entityType: 'WebhookEndpoint', entityId: id }, tx);
    });
    return { id, secret };
  }

  deliveries(schoolId: string, endpointId: string, page: number, pageSize: number) {
    return this.prisma.tenant(schoolId, async (tx) => {
      const where = { schoolId, endpointId };
      const items = await tx.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, event: true, status: true, attempts: true, responseStatus: true, lastError: true, createdAt: true, deliveredAt: true },
      });
      const total = await tx.webhookDelivery.count({ where });
      return { items, total, page, pageSize };
    });
  }

  async redeliver(schoolId: string, deliveryId: string, principal: Principal) {
    await this.prisma.tenant(schoolId, async (tx) => {
      const result = await tx.webhookDelivery.updateMany({ where: { id: deliveryId, schoolId }, data: { status: 'PENDING' } });
      if (result.count === 0) throw new NotFoundException('Delivery not found');
      await this.audit.record({ schoolId, principal, action: 'webhook_delivery.redelivered', entityType: 'WebhookDelivery', entityId: deliveryId }, tx);
    });
    await this.queues.add(QUEUES.outbound, JOBS.deliverWebhook, { deliveryId }, { jobId: `wh-${deliveryId}-manual-${Date.now()}`, attempts: 1 });
    return { queued: true };
  }

  /** Sends a signed `ping` event so the school can test its receiver. */
  async ping(schoolId: string, endpointId: string, principal: Principal) {
    const delivery = await this.prisma.tenant(schoolId, async (tx) => {
      const endpoint = await tx.webhookEndpoint.findFirst({ where: { id: endpointId, schoolId } });
      if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
      const created = await tx.webhookDelivery.create({ data: { schoolId, endpointId, event: 'ping', payload: { message: 'Webhook test from School Payments' } } });
      await this.audit.record({ schoolId, principal, action: 'webhook_endpoint.pinged', entityType: 'WebhookEndpoint', entityId: endpointId }, tx);
      return created;
    });
    await this.queues.add(QUEUES.outbound, JOBS.deliverWebhook, { deliveryId: delivery.id }, { jobId: `wh-${delivery.id}`, attempts: 1 });
    return { deliveryId: delivery.id };
  }
}
