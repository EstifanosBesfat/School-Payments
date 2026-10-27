import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SchoolStatus } from '@payment/db';
import type { CreateSchoolInput, CreateStaffUserInput, PayoutAccountInput, SchoolSettlementInput } from '@payment/shared';
import { AuditService } from '../audit/audit.service';
import { hashPassword } from '../auth/password';
import { SecretBox } from '../common/crypto.util';
import type { Principal } from '../common/principal';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { PrismaService } from '../prisma/prisma.service';

const SCHOOL_PUBLIC_FIELDS = {
  id: true,
  name: true,
  code: true,
  status: true,
  contactEmail: true,
  contactPhone: true,
  city: true,
  tin: true,
  logoUrl: true,
  smsSenderName: true,
  chapaSubaccountId: true,
  payoutBankCode: true,
  settlementSummary: true,
  createdAt: true,
} satisfies Prisma.SchoolSelect;

@Injectable()
export class SchoolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gateways: GatewayRegistry,
    private readonly secrets: SecretBox,
  ) {}

  async create(input: CreateSchoolInput, principal: Principal) {
    const passwordHash = await hashPassword(input.admin.password);
    try {
      return await this.prisma.system(async (tx) => {
        const school = await tx.school.create({
          data: {
            name: input.name,
            code: input.code,
            contactEmail: input.contactEmail,
            contactPhone: input.contactPhone,
            city: input.city,
            tin: input.tin,
            smsSenderName: input.smsSenderName,
          },
          select: SCHOOL_PUBLIC_FIELDS,
        });
        const admin = await tx.user.create({
          data: {
            email: input.admin.email,
            name: input.admin.name,
            passwordHash,
            role: 'SCHOOL_ADMIN',
            schoolId: school.id,
          },
          select: { id: true, email: true, name: true },
        });
        await this.audit.record(
          { schoolId: school.id, principal, action: 'school.created', entityType: 'School', entityId: school.id, metadata: { code: school.code, adminEmail: admin.email } },
          tx,
        );
        return { school, admin };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A school with this code or an admin with this email already exists');
      }
      throw error;
    }
  }

  list() {
    return this.prisma.db.school.findMany({
      orderBy: { createdAt: 'desc' },
      select: { ...SCHOOL_PUBLIC_FIELDS, _count: { select: { students: true, invoices: true } } },
    });
  }

  async setStatus(schoolId: string, status: SchoolStatus, principal: Principal) {
    const school = await this.prisma.db.school.findUnique({ where: { id: schoolId } });
    if (!school) throw new NotFoundException('School not found');
    if (status === 'ACTIVE' && this.gateways.defaultGatewayName === 'chapa' && !school.chapaSubaccountId) {
      throw new BadRequestException('The school must complete payout (subaccount) setup before activation');
    }
    if (status === 'ACTIVE' && this.gateways.defaultGatewayName === 'arifpay' && (!school.payoutBankCode || !school.payoutAccountEncrypted)) {
      throw new BadRequestException('The school must configure a payout bank account before activation');
    }
    return this.prisma.system(async (tx) => {
      const updated = await tx.school.update({ where: { id: schoolId }, data: { status }, select: SCHOOL_PUBLIC_FIELDS });
      await this.audit.record(
        { schoolId, principal, action: 'school.status_changed', entityType: 'School', entityId: schoolId, metadata: { from: school.status, to: status } },
        tx,
      );
      return updated;
    });
  }

  async get(schoolId: string) {
    const school = await this.prisma.db.school.findUnique({ where: { id: schoolId }, select: SCHOOL_PUBLIC_FIELDS });
    if (!school) throw new NotFoundException('School not found');
    return school;
  }

  async update(
    schoolId: string,
    input: { smsSenderName?: string; logoUrl?: string; contactEmail?: string; contactPhone?: string; city?: string },
    principal: Principal,
  ) {
    return this.prisma.system(async (tx) => {
      const updated = await tx.school.update({ where: { id: schoolId }, data: input, select: SCHOOL_PUBLIC_FIELDS });
      await this.audit.record({ schoolId, principal, action: 'school.updated', entityType: 'School', entityId: schoolId, metadata: input }, tx);
      return updated;
    });
  }

  listBanks() {
    return this.gateways.default().listBanks();
  }

  /**
   * Registers the school's bank account as a Chapa subaccount so payers' money settles straight
   * to the school; the platform commission is split off by Chapa. Bank details are stored encrypted.
   */
  async configureSettlement(schoolId: string, input: SchoolSettlementInput, principal: Principal, platformFee: { type: 'percentage' | 'flat'; value: number }) {
    const gateway = this.gateways.default();
    const { subaccountId } = await gateway.createSubaccount({
      businessName: input.businessName,
      accountName: input.accountName,
      bankCode: input.bankCode,
      accountNumber: input.accountNumber,
      splitType: platformFee.type,
      splitValue: platformFee.type === 'flat' ? Math.round(platformFee.value * 100) : platformFee.value,
    });
    const banks = await gateway.listBanks().catch(() => []);
    const bankName = banks.find((bank) => bank.id === input.bankCode)?.name ?? `Bank ${input.bankCode}`;
    const summary = `${bankName} ****${input.accountNumber.slice(-4)}`;
    return this.prisma.system(async (tx) => {
      const updated = await tx.school.update({
        where: { id: schoolId },
        data: {
          chapaSubaccountId: subaccountId,
          settlementEncrypted: this.secrets.encrypt(JSON.stringify(input)),
          settlementSummary: summary,
        },
        select: SCHOOL_PUBLIC_FIELDS,
      });
      await this.audit.record(
        { schoolId, principal, action: 'school.settlement_configured', entityType: 'School', entityId: schoolId, metadata: { summary, gateway: gateway.name } },
        tx,
      );
      return updated;
    });
  }

  listStaff(schoolId: string) {
    return this.prisma.db.user.findMany({
      where: { schoolId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, isActive: true, totpEnabled: true, lastLoginAt: true, createdAt: true },
    });
  }

  async createStaff(schoolId: string, input: CreateStaffUserInput, principal: Principal) {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.prisma.system(async (tx) => {
        const user = await tx.user.create({
          data: { email: input.email, name: input.name, role: input.role, passwordHash, schoolId },
          select: { id: true, email: true, name: true, role: true, isActive: true, totpEnabled: true, createdAt: true },
        });
        await this.audit.record({ schoolId, principal, action: 'staff.created', entityType: 'User', entityId: user.id, metadata: { email: user.email, role: user.role } }, tx);
        return user;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A user with this email already exists');
      }
      throw error;
    }
  }

  async setStaffActive(schoolId: string, userId: string, isActive: boolean, principal: Principal) {
    if (principal.type === 'user' && principal.userId === userId) throw new BadRequestException('You cannot deactivate yourself');
    return this.prisma.system(async (tx) => {
      const result = await tx.user.updateMany({ where: { id: userId, schoolId }, data: { isActive } });
      if (result.count === 0) throw new NotFoundException('User not found');
      if (!isActive) await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record({ schoolId, principal, action: isActive ? 'staff.activated' : 'staff.deactivated', entityType: 'User', entityId: userId }, tx);
      return { id: userId, isActive };
    });
  }

  /**
   * Save or replace the school's ArifPay payout bank account.
   * The account number is encrypted at rest; only the masked last-4 is ever returned.
   */
  async savePayoutAccount(schoolId: string, input: PayoutAccountInput, principal: Principal) {
    const encrypted = this.secrets.encrypt(input.accountNumber);
    const masked = `${input.bankCode} ****${input.accountNumber.slice(-4)}`;
    return this.prisma.system(async (tx) => {
      const updated = await tx.school.update({
        where: { id: schoolId },
        data: {
          payoutBankCode: input.bankCode,
          payoutAccountEncrypted: encrypted,
        },
        select: SCHOOL_PUBLIC_FIELDS,
      });
      await this.audit.record(
        { schoolId, principal, action: 'school.payout_configured', entityType: 'School', entityId: schoolId, metadata: { bankCode: input.bankCode, masked } },
        tx,
      );
      return { ...updated, payoutSummary: masked };
    });
  }

  /** Return the masked payout summary. Never exposes the full account number. */
  getPayoutSummary(school: { payoutBankCode: string | null; payoutAccountEncrypted: string | null }): {
    bankCode: string;
    maskedAccount: string;
    configured: true;
  } | { configured: false } {
    if (!school.payoutBankCode || !school.payoutAccountEncrypted) return { configured: false };
    try {
      const accountNumber = this.secrets.decrypt(school.payoutAccountEncrypted).trim();
      if (!accountNumber) return { configured: false };
      return {
        bankCode: school.payoutBankCode,
        maskedAccount: `****${accountNumber.slice(-4)}`,
        configured: true,
      };
    } catch {
      return { configured: false };
    }
  }

  auditLog(schoolId: string, page: number, pageSize: number) {
    return this.prisma.tenant(schoolId, async (tx) => {
      const items = await tx.auditLog.findMany({ where: { schoolId }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize });
      const total = await tx.auditLog.count({ where: { schoolId } });
      return { items, total, page, pageSize };
    });
  }
}
