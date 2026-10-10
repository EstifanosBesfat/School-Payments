import { BadRequestException, Controller, Headers, HttpCode, Param, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators';
import { WebhooksService } from './webhooks.service';

@ApiTags('gateway-webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Public()
  @SkipThrottle()
  @Post(':gateway')
  @HttpCode(200)
  @ApiOperation({ summary: 'Receives payment gateway webhooks (configure this URL in the Chapa dashboard)' })
  async receive(
    @Param('gateway') gateway: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    if (!request.rawBody) throw new BadRequestException('Missing body');
    return this.webhooks.receive(gateway, request.rawBody, headers);
  }
}
