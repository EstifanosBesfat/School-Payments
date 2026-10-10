import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UnprocessableEntityException,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@payment/db';
import { IDEMPOTENCY_HEADER } from '@payment/shared';
import type { Response } from 'express';
import { from, lastValueFrom, type Observable, of } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { sha256Hex } from './crypto.util';
import { principalActor, type AuthenticatedRequest } from './principal';

const IDEMPOTENT_KEY = 'idempotency:enabled';
const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;
const TTL_MS = 24 * 3600 * 1000;

/**
 * Replays the stored response when a client retries a POST with the same Idempotency-Key, so a
 * network retry can never create a second invoice or a second payment attempt.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const enabled = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const rawKey = request.headers[IDEMPOTENCY_HEADER];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!enabled || !key) return next.handle();
    if (!KEY_PATTERN.test(key)) throw new BadRequestException('Invalid Idempotency-Key header');

    const actor = principalActor(request.principal);
    const scope = `${actor.actorType}:${actor.actorId ?? request.ip ?? 'unknown'}`;
    const requestHash = sha256Hex(`${request.method} ${request.route?.path ?? request.path} ${JSON.stringify(request.body ?? {})}`);

    const existing = await this.prisma.db.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
    if (existing && existing.expiresAt > new Date()) {
      if (existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException('Idempotency-Key was already used with a different request');
      }
      if (existing.responseStatus === null) {
        throw new ConflictException('A request with this Idempotency-Key is still being processed');
      }
      response.status(existing.responseStatus);
      response.setHeader('Idempotent-Replayed', 'true');
      return of(existing.responseBody);
    }
    if (existing) {
      await this.prisma.db.idempotencyKey.delete({ where: { id: existing.id } });
    }

    let record;
    try {
      record = await this.prisma.db.idempotencyKey.create({
        data: { scope, key, requestHash, expiresAt: new Date(Date.now() + TTL_MS) },
      });
    } catch {
      throw new ConflictException('A request with this Idempotency-Key is still being processed');
    }

    const run = async (): Promise<unknown> => {
      try {
        const result = await lastValueFrom(next.handle(), { defaultValue: null });
        await this.prisma.db.idempotencyKey.update({
          where: { id: record.id },
          data: {
            responseStatus: response.statusCode,
            responseBody: result === undefined || result === null ? Prisma.JsonNull : JSON.parse(JSON.stringify(result)),
          },
        });
        return result;
      } catch (error) {
        await this.prisma.db.idempotencyKey.delete({ where: { id: record.id } }).catch(() => undefined);
        throw error;
      }
    };
    return from(run());
  }
}

/** Enables Idempotency-Key handling on a POST route. */
export const Idempotent = () =>
  applyDecorators(SetMetadata(IDEMPOTENT_KEY, true), UseInterceptors(IdempotencyInterceptor));
