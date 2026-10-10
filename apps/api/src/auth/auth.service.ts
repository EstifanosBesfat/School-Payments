import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@payment/db';
import { type LoginInput, ROLES_REQUIRING_2FA } from '@payment/shared';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { AuditService } from '../audit/audit.service';
import { randomToken, SecretBox, sha256Hex } from '../common/crypto.util';
import type { MfaState, UserPrincipal } from '../common/principal';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { burnPasswordCheck, verifyPassword } from './password';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const TOTP_ISSUER = 'School Payments ET';

export interface AccessTokenClaims {
  sub: string;
  typ: 'access';
  role: UserPrincipal['role'];
  sid: string | null;
  mfa: MfaState;
}

export interface ParentTokenClaims {
  sub: string;
  typ: 'parent';
}

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  mfa: MfaState;
  user: { id: string; name: string; email: string; role: string; schoolId: string | null };
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly secrets: SecretBox,
    private readonly audit: AuditService,
  ) {}

  private mfaStateFor(user: Pick<User, 'role' | 'totpEnabled'>): MfaState {
    if (user.totpEnabled) return 'ok';
    return ROLES_REQUIRING_2FA.includes(user.role) ? 'setup_required' : 'not_required';
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<TokenPair> {
    const user = await this.prisma.db.user.findUnique({ where: { email: input.email } });
    if (!user || !user.isActive || user.role === 'PARENT') {
      await burnPasswordCheck(input.password);
      throw new UnauthorizedException('Invalid email or password');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Too many failed attempts. Try again in 15 minutes.');
    }

    const passwordOk = await verifyPassword(user.passwordHash, input.password);
    if (!passwordOk) {
      await this.recordFailure(user, meta, 'password');
      throw new UnauthorizedException('Invalid email or password');
    }

    let totpStep: number | null = null;
    if (user.totpEnabled && user.totpSecretEncrypted) {
      if (!input.totpCode) {
        throw new UnauthorizedException({ code: 'TOTP_REQUIRED', message: 'Enter the 6-digit code from your authenticator app' });
      }
      totpStep = verifyTotp(this.secrets.decrypt(user.totpSecretEncrypted), input.totpCode, { lastUsedStep: user.totpLastUsedStep });
      if (totpStep === null) {
        await this.recordFailure(user, meta, 'totp');
        throw new UnauthorizedException({ code: 'TOTP_INVALID', message: 'The authentication code is not valid' });
      }
    }

    const updated = await this.prisma.db.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        ...(totpStep !== null ? { totpLastUsedStep: totpStep } : {}),
      },
    });
    await this.audit.record({
      schoolId: user.schoolId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
      ip: meta.ip,
      metadata: { mfa: this.mfaStateFor(updated) },
    });
    return this.issueTokens(updated, meta);
  }

  private async recordFailure(user: User, meta: RequestMeta, reason: 'password' | 'totp'): Promise<void> {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await this.prisma.db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MS) : user.lockedUntil },
    });
    await this.audit.record({
      schoolId: user.schoolId,
      actorType: 'user',
      actorId: user.id,
      action: lock ? 'auth.locked' : 'auth.login_failed',
      entityType: 'User',
      entityId: user.id,
      ip: meta.ip,
      metadata: { reason },
    });
  }

  private async issueTokens(user: User, meta: RequestMeta, familyId: string = randomUUID()): Promise<TokenPair> {
    if (user.role === 'PARENT') throw new ForbiddenException();
    const mfa = this.mfaStateFor(user);
    const claims: AccessTokenClaims = { sub: user.id, typ: 'access', role: user.role, sid: user.schoolId, mfa };
    const accessToken = await this.jwt.signAsync(claims, { expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS });
    const refreshToken = randomToken(48);
    const refreshExpires = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000);
    await this.prisma.db.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: sha256Hex(refreshToken),
        expiresAt: refreshExpires,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 300),
      },
    });
    return {
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + this.env.ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpires.toISOString(),
      mfa,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, schoolId: user.schoolId },
    };
  }

  /** Rotates the refresh token. Presenting an already-rotated token revokes the whole session family. */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<TokenPair> {
    const record = await this.prisma.db.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(refreshToken) },
      include: { user: true },
    });
    if (!record) throw new UnauthorizedException('Session expired');
    if (record.revokedAt) {
      await this.prisma.db.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record({
        schoolId: record.user.schoolId,
        actorType: 'user',
        actorId: record.userId,
        action: 'auth.refresh_token_reuse',
        entityType: 'User',
        entityId: record.userId,
        ip: meta.ip,
      });
      throw new UnauthorizedException('Session expired');
    }
    if (record.expiresAt < new Date() || !record.user.isActive) throw new UnauthorizedException('Session expired');

    const revoked = await this.prisma.db.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) throw new UnauthorizedException('Session expired');
    const pair = await this.issueTokens(record.user, meta, record.familyId);
    const next = await this.prisma.db.refreshToken.findUnique({ where: { tokenHash: sha256Hex(pair.refreshToken) } });
    await this.prisma.db.refreshToken.update({ where: { id: record.id }, data: { replacedById: next?.id } });
    return pair;
  }

  async logout(refreshToken: string): Promise<void> {
    const record = await this.prisma.db.refreshToken.findUnique({ where: { tokenHash: sha256Hex(refreshToken) } });
    if (!record) return;
    await this.prisma.db.refreshToken.updateMany({
      where: { familyId: record.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async beginTotpSetup(userId: string): Promise<{ otpauthUrl: string; qrCodeDataUrl: string; secret: string }> {
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabled) throw new BadRequestException('Two-factor authentication is already enabled');
    const secret = generateTotpSecret();
    await this.prisma.db.user.update({ where: { id: userId }, data: { totpSecretEncrypted: this.secrets.encrypt(secret) } });
    const url = otpauthUrl(secret, user.email, TOTP_ISSUER);
    return { otpauthUrl: url, qrCodeDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 240 }), secret };
  }

  async enableTotp(userId: string, code: string, meta: RequestMeta): Promise<TokenPair> {
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabled) throw new BadRequestException('Two-factor authentication is already enabled');
    if (!user.totpSecretEncrypted) throw new BadRequestException('Start two-factor setup first');
    const step = verifyTotp(this.secrets.decrypt(user.totpSecretEncrypted), code);
    if (step === null) throw new BadRequestException('The code is not valid. Check your phone clock and try again.');
    const updated = await this.prisma.db.user.update({
      where: { id: userId },
      data: { totpEnabled: true, totpLastUsedStep: step },
    });
    await this.prisma.db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({
      schoolId: user.schoolId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.2fa_enabled',
      entityType: 'User',
      entityId: user.id,
      ip: meta.ip,
    });
    return this.issueTokens(updated, meta);
  }

  async me(userId: string) {
    const user = await this.prisma.db.user.findUniqueOrThrow({
      where: { id: userId },
      include: { school: { select: { id: true, name: true, code: true, status: true, logoUrl: true } } },
    });
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      totpEnabled: user.totpEnabled,
      mfa: this.mfaStateFor(user),
      school: user.school,
    };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims | ParentTokenClaims> {
    return this.jwt.verifyAsync<AccessTokenClaims | ParentTokenClaims>(token, { algorithms: ['HS256'] });
  }

  async signParentToken(phone: string): Promise<{ accessToken: string; expiresAt: string }> {
    const ttl = 2 * 3600;
    const claims: ParentTokenClaims = { sub: phone, typ: 'parent' };
    return {
      accessToken: await this.jwt.signAsync(claims, { expiresIn: ttl }),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }
}
