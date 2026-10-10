import { ForbiddenException } from '@nestjs/common';
import type { ApiKeyScope, UserRole } from '@payment/shared';
import type { Request } from 'express';

export type MfaState = 'ok' | 'setup_required' | 'not_required';

export interface UserPrincipal {
  type: 'user';
  userId: string;
  role: Exclude<UserRole, 'PARENT'>;
  schoolId: string | null;
  mfa: MfaState;
}

export interface ApiKeyPrincipal {
  type: 'api_key';
  apiKeyId: string;
  schoolId: string;
  scopes: ApiKeyScope[];
}

export interface ParentPrincipal {
  type: 'parent';
  phone: string;
}

export type Principal = UserPrincipal | ApiKeyPrincipal | ParentPrincipal;

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
}

export function principalActor(principal: Principal | undefined): { actorType: string; actorId: string | null } {
  if (!principal) return { actorType: 'anonymous', actorId: null };
  switch (principal.type) {
    case 'user':
      return { actorType: 'user', actorId: principal.userId };
    case 'api_key':
      return { actorType: 'api_key', actorId: principal.apiKeyId };
    case 'parent':
      return { actorType: 'parent', actorId: principal.phone };
  }
}

/** The school a staff user or API key acts for. Never read schoolId from the request body. */
export function requireSchoolId(principal: Principal | undefined): string {
  if (principal && (principal.type === 'user' || principal.type === 'api_key') && principal.schoolId) {
    return principal.schoolId;
  }
  throw new ForbiddenException('This action requires a school account');
}
