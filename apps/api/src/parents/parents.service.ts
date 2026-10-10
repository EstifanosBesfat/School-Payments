import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type Language, shortVerificationCode } from '@payment/shared';
import { randomInt } from 'node:crypto';
import { AuthService } from '../auth/auth.service';
import { hmacSha256Hex, safeEqual } from '../common/crypto.util';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_WINDOW_MS = 15 * 60 * 1000;
const OTP_MAX_PER_WINDOW = 3;
const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class ParentsService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService,
  ) {}

  private hashCode(phone: string, code: string): string {
    return hmacSha256Hex(this.env.JWT_ACCESS_SECRET, `parent-otp:${phone}:${code}`);
  }

  /**
   * Always answers the same way whether or not the phone belongs to a guardian, so the endpoint
   * cannot be used to discover which numbers are registered.
   */
  async requestOtp(phone: string): Promise<{ sent: true; expiresInSeconds: number }> {
    const recent = await this.prisma.db.parentOtp.count({ where: { phone, createdAt: { gt: new Date(Date.now() - OTP_WINDOW_MS) } } });
    if (recent >= OTP_MAX_PER_WINDOW) {
      throw new HttpException('Too many codes requested. Try again in 15 minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const guardian = await this.prisma.db.guardian.findFirst({ where: { phone }, select: { language: true }, orderBy: { updatedAt: 'desc' } });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.db.parentOtp.create({
      data: { phone, codeHash: this.hashCode(phone, guardian ? code : `${code}-unregistered`), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    });
    if (guardian) await this.notifications.parentOtp(phone, code, guardian.language as Language);
    return { sent: true, expiresInSeconds: OTP_TTL_MS / 1000 };
  }

  async verifyOtp(phone: string, code: string) {
    const otp = await this.prisma.db.parentOtp.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw new UnauthorizedException('The code is invalid or has expired');
    if (!safeEqual(otp.codeHash, this.hashCode(phone, code))) {
      await this.prisma.db.parentOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new UnauthorizedException('The code is invalid or has expired');
    }
    const consumed = await this.prisma.db.parentOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (consumed.count === 0) throw new UnauthorizedException('The code is invalid or has expired');
    return this.auth.signParentToken(phone);
  }

  /** Everything billed to children linked to this phone, across all schools. */
  async overview(phone: string) {
    const links = await this.prisma.db.studentGuardian.findMany({
      where: { guardian: { phone } },
      select: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            code: true,
            grade: true,
            section: true,
            school: { select: { id: true, name: true, status: true } },
            invoices: {
              where: { status: { notIn: ['DRAFT', 'CANCELLED'] } },
              orderBy: { createdAt: 'desc' },
              take: 50,
              select: {
                id: true,
                number: true,
                term: true,
                status: true,
                totalAmount: true,
                paidAmount: true,
                dueDate: true,
                payToken: true,
                receipts: { select: { id: true, receiptNo: true, issuedAt: true, payloadHash: true }, orderBy: { issuedAt: 'desc' } },
              },
            },
          },
        },
      },
    });
    return {
      phone,
      students: links.map(({ student }) => ({
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        code: student.code,
        grade: student.grade,
        section: student.section,
        school: student.school.name,
        invoices: student.invoices.map(({ receipts, ...invoice }) => ({
          ...invoice,
          dueDate: invoice.dueDate.toISOString().slice(0, 10),
          balance: invoice.totalAmount - invoice.paidAmount,
          receipts: receipts.map(({ payloadHash, ...receipt }) => ({ ...receipt, verificationCode: shortVerificationCode(payloadHash) })),
        })),
      })),
    };
  }
}
