import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators';
import { HealthService } from './health.service';

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Process liveness. Does not call PostgreSQL, Redis, Chapa, or SMS. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const report = await this.health.ready();
    if (report.status !== 'ok') throw new ServiceUnavailableException(report);
    return report;
  }

  @Get('workers')
  @ApiOperation({
    summary: 'Background worker health check',
    description: `Monitors sweep worker and reconciliation system health.
    
    This endpoint helps detect multi-attempt checkout sync failures by checking:
    - Open reconciliation issues (payment discrepancies between Chapa and database)
    - Stale pending payments (not picked up by 5-minute sweep worker)
    - Last reconciliation run (nightly job at 2:30 AM)
    
    Returns 503 if critical issues detected (status: 'critical').`,
  })
  async workers() {
    const report = await this.health.workers();
    if (report.status === 'critical') throw new ServiceUnavailableException(report);
    return report;
  }
}
