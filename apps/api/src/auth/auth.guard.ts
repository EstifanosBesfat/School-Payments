import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type ApiKeyScope, ROLES_REQUIRING_2FA, type UserRole } from '@payment/shared';
import {
  ALLOW_MFA_SETUP_KEY,
  IS_PUBLIC_KEY,
  ROLES_KEY,
  SCOPES_KEY,
} from '../common/decorators';
import type { AuthenticatedRequest, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeysService } from './api-keys.service';
import { AuthService } from './auth.service';

/**
 * Global guard. Authenticates (JWT bearer for staff/parents, X-Api-Key for integrations) and
 * authorizes against @Roles / @ApiKeyScopes metadata. Staff who must enroll in 2FA can only reach
 * routes marked @AllowDuringMfaSetup until they do.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly apiKeys: ApiKeysService,
    private readonly prisma: PrismaService,
  ) {}

  private metadata<T>(key: string, context: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);
  }

  private async authenticate(request: AuthenticatedRequest): Promise<Principal | undefined> {
    const apiKeyHeader = request.headers['x-api-key'];
    const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    if (apiKey) return this.apiKeys.authenticate(apiKey);

    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return undefined;
    let claims;
    try {
      claims = await this.auth.verifyAccessToken(authorization.slice(7));
    } catch {
      throw new UnauthorizedException('Session expired');
    }
    if (claims.typ === 'parent') return { type: 'parent', phone: claims.sub };

    const user = await this.prisma.db.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, role: true, schoolId: true, isActive: true, totpEnabled: true },
    });
    if (!user || !user.isActive || user.role === 'PARENT') throw new UnauthorizedException('Session expired');
    return {
      type: 'user',
      userId: user.id,
      role: user.role,
      schoolId: user.schoolId,
      mfa: user.totpEnabled ? 'ok' : ROLES_REQUIRING_2FA.includes(user.role) ? 'setup_required' : 'not_required',
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const isPublic = this.metadata<boolean>(IS_PUBLIC_KEY, context) ?? false;

    let principal: Principal | undefined;
    try {
      principal = await this.authenticate(request);
    } catch (error) {
      if (!isPublic) throw error;
    }
    request.principal = principal;
    if (isPublic) return true;
    if (!principal) throw new UnauthorizedException('Sign in required');

    const roles = this.metadata<UserRole[]>(ROLES_KEY, context);
    const scopes = this.metadata<ApiKeyScope[]>(SCOPES_KEY, context);

    switch (principal.type) {
      case 'api_key': {
        if (!scopes || scopes.length === 0) throw new ForbiddenException('This endpoint is not available to API keys');
        const missing = scopes.filter((scope) => !principal.scopes.includes(scope));
        if (missing.length > 0) throw new ForbiddenException(`API key is missing scopes: ${missing.join(', ')}`);
        return true;
      }
      case 'parent': {
        if (!roles?.includes('PARENT')) throw new ForbiddenException();
        return true;
      }
      case 'user': {
        const allowDuringSetup = this.metadata<boolean>(ALLOW_MFA_SETUP_KEY, context) ?? false;
        if (principal.mfa === 'setup_required' && !allowDuringSetup) {
          throw new ForbiddenException({ code: 'MFA_SETUP_REQUIRED', message: 'Set up two-factor authentication to continue' });
        }
        if (roles && roles.length > 0 && !roles.includes(principal.role)) throw new ForbiddenException();
        return true;
      }
    }
  }
}
