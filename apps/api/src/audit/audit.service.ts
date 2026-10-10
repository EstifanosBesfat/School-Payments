import { Injectable } from '@nestjs/common';
import type { Prisma } from '@payment/db';
import { principalActor, type Principal } from '../common/principal';
import { PrismaService, type Tx } from '../prisma/prisma.service';

export interface AuditEntry {
  schoolId?: string | null;
  principal?: Principal;
  actorType?: string;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
}

/** Append-only audit trail. Rows can never be updated or deleted (enforced by a DB trigger). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    const actor = entry.principal
      ? principalActor(entry.principal)
      : { actorType: entry.actorType ?? 'system', actorId: entry.actorId ?? null };
    const client = tx ?? this.prisma.db;
    await client.auditLog.create({
      data: {
        schoolId: entry.schoolId ?? null,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata,
        ip: entry.ip,
      },
    });
  }
}
