import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type CreateApiKeyInput, createApiKeySchema, type CreateWebhookEndpointInput, createWebhookEndpointSchema, paginationSchema } from '@payment/shared';
import { z } from 'zod';
import { ApiKeysService } from '../auth/api-keys.service';
import { CurrentPrincipal, Roles } from '../common/decorators';
import { type Principal, requireSchoolId } from '../common/principal';
import { ZodValidationPipe, zodBody } from '../common/zod-validation.pipe';
import { WebhookEndpointsService } from './webhook-endpoints.service';

const activeSchema = z.object({ isActive: z.boolean() });

@ApiTags('integrations')
@ApiBearerAuth()
@Roles('SCHOOL_ADMIN')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly endpoints: WebhookEndpointsService,
  ) {}

  @Get('api-keys')
  listKeys(@CurrentPrincipal() principal: Principal) {
    return this.apiKeys.list(requireSchoolId(principal));
  }

  @Post('api-keys')
  createKey(@CurrentPrincipal() principal: Principal, @Body(zodBody(createApiKeySchema)) body: CreateApiKeyInput) {
    if (principal.type !== 'user') throw new ForbiddenException('Only staff can create API keys');
    return this.apiKeys.create(requireSchoolId(principal), principal, body);
  }

  @Delete('api-keys/:id')
  @HttpCode(204)
  async revokeKey(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    await this.apiKeys.revoke(requireSchoolId(principal), principal, id);
  }

  @Get('webhooks')
  listEndpoints(@CurrentPrincipal() principal: Principal) {
    return this.endpoints.list(requireSchoolId(principal));
  }

  @Post('webhooks')
  createEndpoint(@CurrentPrincipal() principal: Principal, @Body(zodBody(createWebhookEndpointSchema)) body: CreateWebhookEndpointInput) {
    return this.endpoints.create(requireSchoolId(principal), body, principal);
  }

  @Patch('webhooks/:id')
  setActive(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(zodBody(activeSchema)) body: z.infer<typeof activeSchema>) {
    return this.endpoints.setActive(requireSchoolId(principal), id, body.isActive, principal);
  }

  @Post('webhooks/:id/rotate-secret')
  rotate(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.endpoints.rotateSecret(requireSchoolId(principal), id, principal);
  }

  @Post('webhooks/:id/ping')
  ping(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.endpoints.ping(requireSchoolId(principal), id, principal);
  }

  @Get('webhooks/:id/deliveries')
  deliveries(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Query(new ZodValidationPipe(paginationSchema)) query: z.infer<typeof paginationSchema>) {
    return this.endpoints.deliveries(requireSchoolId(principal), id, query.page, query.pageSize);
  }

  @Post('deliveries/:id/redeliver')
  redeliver(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.endpoints.redeliver(requireSchoolId(principal), id, principal);
  }
}
