import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { API_KEY_SCOPES, type ApiKeyScope, type CreateApiKeyInput } from '@payment/shared';
import { AuditService } from '../audit/audit.service';
import { randomToken, sha256Hex } from '../common/crypto.util';
import type { ApiKeyPrincipal, Principal } from '../common/principal';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';

const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async authenticate(rawKey: string): Promise<ApiKeyPrincipal> {
    if (!/^sk_(live|test)_[A-Za-z0-9_-]{20,80}$/.test(rawKey)) throw new UnauthorizedException('Invalid API key');
    const key = await this.prisma.db.apiKey.findUnique({
      where: { keyHash: sha256Hex(rawKey) },
      include: { school: { select: { status: true } } },
    });
    if (!key || key.revokedAt || key.school.status === 'SUSPENDED') throw new UnauthorizedException('Invalid API key');
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      await this.prisma.db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    }
    return {
      type: 'api_key',
      apiKeyId: key.id,
      schoolId: key.schoolId,
      scopes: key.scopes.filter((scope): scope is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(scope)),
    };
  }

  /** Returns the plaintext key exactly once. Only its SHA-256 hash is stored. */
  async create(schoolId: string, principal: Principal & { type: 'user' }, input: CreateApiKeyInput) {
    const mode = this.env.NODE_ENV === 'production' ? 'live' : 'test';
    const rawKey = `sk_${mode}_${randomToken(32)}`;
    const record = await this.prisma.tenant(schoolId, async (tx) => {
      const created = await tx.apiKey.create({
        data: {
          schoolId,
          name: input.name,
          prefix: rawKey.slice(0, 14),
          keyHash: sha256Hex(rawKey),
          scopes: input.scopes,
          createdById: principal.userId,
        },
      });
      await this.audit.record(
        { schoolId, principal, action: 'api_key.created', entityType: 'ApiKey', entityId: created.id, metadata: { name: input.name, scopes: input.scopes } },
        tx,
      );
      return created;
    });
    return { id: record.id, name: record.name, prefix: record.prefix, scopes: record.scopes, key: rawKey };
  }

  list(schoolId: string) {
    return this.prisma.tenant(schoolId, (tx) =>
      tx.apiKey.findMany({
        where: { schoolId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, revokedAt: true, createdAt: true },
      }),
    );
  }

  async revoke(schoolId: string, principal: Principal, id: string): Promise<void> {
    await this.prisma.tenant(schoolId, async (tx) => {
      const result = await tx.apiKey.updateMany({ where: { id, schoolId, revokedAt: null }, data: { revokedAt: new Date() } });
      if (result.count === 0) throw new NotFoundException('API key not found');
      await this.audit.record({ schoolId, principal, action: 'api_key.revoked', entityType: 'ApiKey', entityId: id }, tx);
    });
  }
}
