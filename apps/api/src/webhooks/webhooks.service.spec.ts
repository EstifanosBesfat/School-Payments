import { createHmac } from 'node:crypto';
import { Prisma } from '@payment/db';
import type { Job } from 'bullmq';
import { ChapaGateway } from '../gateways/chapa.gateway';
import { JOBS, type ProcessWebhookEventJob } from '../queue/queue.constants';
import { GatewaySuccessUnconfirmedError, gatewayPayloadClaimsSuccess, WebhooksService } from './webhooks.service';

const secret = 'test-webhook-secret';

function sign(value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function harness() {
  const events = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const added: { webhookEventId: string }[] = [];
  let handler: ((job: Job<ProcessWebhookEventJob>) => Promise<void>) | undefined;
  const verifyAndSettle = jest.fn();

  const prisma = {
    db: {
      webhookEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if ([...events.values()].some((event) => event.eventKey === data.eventKey)) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
          }
          seq += 1;
          const event = { id: `evt_${seq}`, status: 'RECEIVED', attempts: 0, error: null, processedAt: null, ...data };
          events.set(event.id, event);
          return event;
        },
        findUnique: async ({ where }: { where: { id: string } }) => events.get(where.id) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const event = events.get(where.id);
          if (!event) throw new Error('missing event');
          const attempts = data.attempts as { increment?: number } | undefined;
          if (attempts?.increment) event.attempts = Number(event.attempts) + attempts.increment;
          if (data.status) event.status = data.status;
          if ('error' in data) event.error = data.error;
          if ('processedAt' in data) event.processedAt = data.processedAt;
          return event;
        },
      },
    },
  };

  const service = new WebhooksService(
    prisma as never,
    { get: () => new ChapaGateway({ baseUrl: 'https://api.chapa.co/v1', secretKey: 'test', webhookSecret: secret }) } as never,
    { verifyAndSettle } as never,
    {
      register: (_queue: string, _name: string, fn: (job: Job<ProcessWebhookEventJob>) => Promise<void>) => {
        handler = fn;
      },
      add: async (_queue: string, _name: string, data: { webhookEventId: string }) => {
        added.push(data);
      },
    } as never,
  );
  service.onModuleInit();
  if (!handler) throw new Error('webhook handler was not registered');
  const process = handler;

  async function receive(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    return service.receive('chapa', Buffer.from(raw), { 'x-chapa-signature': sign(raw) });
  }

  return { service, events, added, verifyAndSettle, process, receive };
}

describe('gatewayPayloadClaimsSuccess', () => {
  it('recognizes Chapa success payloads and ignores failure payloads', () => {
    expect(gatewayPayloadClaimsSuccess({ event: 'charge.success', status: 'success' })).toBe(true);
    expect(gatewayPayloadClaimsSuccess({ event: 'payment.success', status: 'success' })).toBe(true);
    expect(gatewayPayloadClaimsSuccess({ event: 'charge.failed/cancelled', status: 'failed/cancelled' })).toBe(false);
    expect(gatewayPayloadClaimsSuccess({ event: 'charge.failed', status: 'failed' })).toBe(false);
    expect(gatewayPayloadClaimsSuccess(null)).toBe(false);
  });
});

describe('Chapa webhook delivery', () => {
  const failedBody = { event: 'charge.failed/cancelled', tx_ref: 'DEMO-TX1', status: 'failed/cancelled', amount: '1500.00' };
  const successBody = { event: 'charge.success', tx_ref: 'DEMO-TX1', status: 'success', amount: '1500.00', reference: 'AP123' };

  it('stores one row for a redelivered failure and still accepts the later success', async () => {
    const { added, receive } = harness();
    const first = await receive(failedBody);
    const duplicate = await receive(failedBody);
    const success = await receive(successBody);
    expect(first).toEqual({ received: true, duplicate: false });
    expect(duplicate).toEqual({ received: true, duplicate: true });
    expect(success).toEqual({ received: true, duplicate: false });
    expect(added).toHaveLength(2);
    expect(added[0]?.webhookEventId).not.toBe(added[1]?.webhookEventId);
  });

  it('retries an unconfirmed success and does not mark it processed', async () => {
    const { events, verifyAndSettle, process, receive } = harness();
    await receive(successBody);
    const eventId = [...events.keys()][0];
    if (!eventId) throw new Error('expected a stored webhook');
    verifyAndSettle.mockResolvedValue('already_failed');
    await expect(process({ name: JOBS.processWebhookEvent, data: { webhookEventId: eventId } } as Job<ProcessWebhookEventJob>)).rejects.toBeInstanceOf(
      GatewaySuccessUnconfirmedError,
    );
    expect(events.get(eventId)?.status).toBe('FAILED');
    expect(verifyAndSettle).toHaveBeenCalledTimes(1);
  });

  it('does not treat a pending verification as a completed success', async () => {
    const { events, verifyAndSettle, process, receive } = harness();
    await receive({ event: 'charge.success', tx_ref: 'DEMO-TX1', status: 'pending' });
    const eventId = [...events.keys()][0];
    verifyAndSettle.mockResolvedValue('still_pending');
    await expect(process({ name: JOBS.processWebhookEvent, data: { webhookEventId: eventId } } as Job<ProcessWebhookEventJob>)).rejects.toBeInstanceOf(
      GatewaySuccessUnconfirmedError,
    );
    expect(events.get(eventId ?? '')?.status).toBe('FAILED');
  });

  it('processes a confirmed success once and ignores a duplicate delivery of that event', async () => {
    const { events, verifyAndSettle, process, receive } = harness();
    await receive(successBody);
    const eventId = [...events.keys()][0];
    if (!eventId) throw new Error('expected a stored webhook');
    verifyAndSettle.mockResolvedValue('succeeded');
    await process({ name: JOBS.processWebhookEvent, data: { webhookEventId: eventId } } as Job<ProcessWebhookEventJob>);
    await process({ name: JOBS.processWebhookEvent, data: { webhookEventId: eventId } } as Job<ProcessWebhookEventJob>);
    expect(events.get(eventId)?.status).toBe('PROCESSED');
    expect(verifyAndSettle).toHaveBeenCalledTimes(1);
    expect(verifyAndSettle).toHaveBeenCalledWith('DEMO-TX1', 'webhook');
  });

  it('acks a second success event without paying again when settlement is already final', async () => {
    const { events, verifyAndSettle, process, receive } = harness();
    await receive(successBody);
    await receive({ ...successBody, updated_at: '2026-10-18T12:00:00.000Z' });
    const ids = [...events.keys()];
    verifyAndSettle.mockResolvedValueOnce('succeeded').mockResolvedValueOnce('already_final');
    await process({ name: JOBS.processWebhookEvent, data: { webhookEventId: ids[0] } } as Job<ProcessWebhookEventJob>);
    await process({ name: JOBS.processWebhookEvent, data: { webhookEventId: ids[1] } } as Job<ProcessWebhookEventJob>);
    expect(ids).toHaveLength(2);
    expect(events.get(ids[1] ?? '')?.status).toBe('PROCESSED');
    expect(verifyAndSettle).toHaveBeenCalledTimes(2);
  });

  it('does not let a later failure webhook unwind a confirmed success', async () => {
    const { events, verifyAndSettle, process, receive } = harness();
    await receive(failedBody);
    const eventId = [...events.keys()][0];
    verifyAndSettle.mockResolvedValue('already_final');
    await process({ name: JOBS.processWebhookEvent, data: { webhookEventId: eventId } } as Job<ProcessWebhookEventJob>);
    expect(events.get(eventId ?? '')?.status).toBe('PROCESSED');
    expect(verifyAndSettle).toHaveBeenCalledWith('DEMO-TX1', 'webhook');
  });

  it('records a mismatched verification without treating it as paid', async () => {
    const { events, verifyAndSettle, process, receive } = harness();
    await receive(successBody);
    const eventId = [...events.keys()][0];
    verifyAndSettle.mockResolvedValue('rejected');
    await process({ name: JOBS.processWebhookEvent, data: { webhookEventId: eventId } } as Job<ProcessWebhookEventJob>);
    expect(events.get(eventId ?? '')?.status).toBe('PROCESSED');
    expect(events.get(eventId ?? '')?.error).toBe('Verification did not match this payment');
  });
});
