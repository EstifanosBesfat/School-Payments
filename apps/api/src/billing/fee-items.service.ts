import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@payment/db';
import type { CreateFeeItemInput } from '@payment/shared';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';

export interface UpdateFeeItemInput {
  name?: string;
  description?: string | null;
  amount?: number;
  isActive?: boolean;
}

@Injectable()
export class FeeItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(schoolId: string, includeInactive: boolean) {
    return this.prisma.tenant(schoolId, (tx) =>
      tx.feeItem.findMany({
        where: { schoolId, ...(includeInactive ? {} : { isActive: true }) },
        orderBy: { name: 'asc' },
      }),
    );
  }

  async create(schoolId: string, input: CreateFeeItemInput, principal: Principal) {
    try {
      return await this.prisma.tenant(schoolId, async (tx) => {
        const item = await tx.feeItem.create({ data: { schoolId, name: input.name, description: input.description, amount: input.amount } });
        await this.audit.record({ schoolId, principal, action: 'fee_item.created', entityType: 'FeeItem', entityId: item.id, metadata: { name: item.name, amount: item.amount } }, tx);
        return item;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`A fee item named "${input.name}" already exists`);
      }
      throw error;
    }
  }

  /** Changing a fee amount never alters invoices already issued; their lines keep the old amount. */
  async update(schoolId: string, feeItemId: string, input: UpdateFeeItemInput, principal: Principal) {
    return this.prisma.tenant(schoolId, async (tx) => {
      const existing = await tx.feeItem.findFirst({ where: { id: feeItemId, schoolId } });
      if (!existing) throw new NotFoundException('Fee item not found');
      const item = await tx.feeItem.update({ where: { id: feeItemId }, data: input });
      await this.audit.record(
        { schoolId, principal, action: 'fee_item.updated', entityType: 'FeeItem', entityId: item.id, metadata: { before: { amount: existing.amount, isActive: existing.isActive }, after: { ...input } } },
        tx,
      );
      return item;
    });
  }
}
