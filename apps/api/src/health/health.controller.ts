import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const checks: Record<string, 'ok' | 'down'> = { database: 'down', redis: 'down' };
    await this.prisma.db.$queryRaw`SELECT 1`.then(() => (checks.database = 'ok')).catch(() => undefined);
    await this.queues.connection
      .ping()
      .then(() => (checks.redis = 'ok'))
      .catch(() => undefined);
    const healthy = Object.values(checks).every((value) => value === 'ok');
    if (!healthy) throw new ServiceUnavailableException({ status: 'degraded', checks });
    return { status: 'ok', checks };
  }
}
