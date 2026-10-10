import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { ApiKeyScope, UserRole } from '@payment/shared';
import type { AuthenticatedRequest, Principal } from './principal';

export const IS_PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';
export const SCOPES_KEY = 'auth:scopes';
export const ALLOW_MFA_SETUP_KEY = 'auth:allowMfaSetup';
export const ALLOW_API_KEY = 'auth:allowApiKey';

/** Route needs no authentication (pay pages, gateway webhooks, receipt verification). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Staff/parent roles allowed on the route. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Route may be called with an API key that has all listed scopes. */
export const ApiKeyScopes = (...scopes: ApiKeyScope[]) => SetMetadata(SCOPES_KEY, scopes);

/** Route is reachable before a staff user finished mandatory 2FA enrollment. */
export const AllowDuringMfaSetup = () => SetMetadata(ALLOW_MFA_SETUP_KEY, true);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().principal,
);

export const ClientIp = createParamDecorator((_data: unknown, context: ExecutionContext): string | undefined => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.ip;
});
