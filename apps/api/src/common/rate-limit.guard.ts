import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerException,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { apiKeyTracker, clientAddress, trustedProxySet } from './client-address';

const SKIP_KEY = 'THROTTLER:SKIPdefault';
const LIMIT_KEY = 'THROTTLER:LIMITdefault';
const TTL_KEY = 'THROTTLER:TTLdefault';

@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {
    super(options, storageService, reflector);
  }

  protected override async getTracker(req: Record<string, any>): Promise<string> {
    return clientAddress(req, trustedProxySet(this.env.TRUSTED_PROXIES));
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.skipped(context)) return true;
    await super.canActivate(context);
    await this.trackApiKey(context);
    return true;
  }

  private skipped(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(SKIP_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  /** Same route limit, keyed by the API key, so rotating the caller address does not reset it. */
  private async trackApiKey(context: ExecutionContext): Promise<void> {
    const { req, res } = this.getRequestResponse(context);
    const headers = req.headers as Record<string, string | string[] | undefined> | undefined;
    const tracker = apiKeyTracker(headers?.['x-api-key']);
    if (!tracker) return;
    const named =
      this.throttlers.find((throttler) => throttler.name === 'default') ?? this.throttlers[0];
    if (!named || typeof named.limit !== 'number' || typeof named.ttl !== 'number') return;
    const limit = this.routeNumber(context, LIMIT_KEY, named.limit);
    const ttl = this.routeNumber(context, TTL_KEY, named.ttl);
    const key = this.generateKey(context, `apikey:${tracker}`, named.name ?? 'default');
    const record = await this.storageService.increment(
      key,
      ttl,
      limit,
      ttl,
      named.name ?? 'default',
    );
    if (!record.isBlocked) return;
    this.setResponseHeader(res, 'Retry-After', record.timeToBlockExpire);
    throw new ThrottlerException();
  }

  private routeNumber(context: ExecutionContext, metadataKey: string, fallback: number): number {
    const value = this.reflector.getAllAndOverride<number>(metadataKey, [
      context.getHandler(),
      context.getClass(),
    ]);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }
}
