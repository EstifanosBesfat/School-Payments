import { Global, Module } from '@nestjs/common';
import { GatewayRegistry } from './gateway.registry';
import { MockGatewayController } from './mock-gateway.controller';

@Global()
@Module({
  controllers: [MockGatewayController],
  providers: [GatewayRegistry],
  exports: [GatewayRegistry],
})
export class GatewaysModule {}
