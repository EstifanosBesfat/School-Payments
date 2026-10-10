import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { paginationSchema } from '@payment/shared';
import { z } from 'zod';
import { CurrentPrincipal, Roles } from '../common/decorators';
import { type Principal, requireSchoolId } from '../common/principal';
import { ZodValidationPipe, zodBody } from '../common/zod-validation.pipe';
import { ReconciliationService } from './reconciliation.service';

const issuesQuery = paginationSchema.extend({
  status: z.enum(['OPEN', 'RESOLVED']).optional(),
  schoolId: z.string().optional(),
});
const resolveSchema = z.object({ note: z.string().trim().min(3).max(1000) });

@ApiTags('reconciliation')
@ApiBearerAuth()
@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Roles('PLATFORM_ADMIN')
  @Post('run')
  run() {
    return this.reconciliation.run();
  }

  @Roles('PLATFORM_ADMIN')
  @Get('runs')
  runs() {
    return this.reconciliation.runs(30);
  }

  @Roles('PLATFORM_ADMIN', 'SCHOOL_ADMIN', 'ACCOUNTANT')
  @Get('issues')
  issues(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(issuesQuery)) query: z.infer<typeof issuesQuery>) {
    const isPlatform = principal.type === 'user' && principal.role === 'PLATFORM_ADMIN';
    return this.reconciliation.issues({
      schoolId: isPlatform ? query.schoolId : requireSchoolId(principal),
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Roles('PLATFORM_ADMIN', 'SCHOOL_ADMIN', 'ACCOUNTANT')
  @Post('issues/:id/resolve')
  resolve(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(zodBody(resolveSchema)) body: z.infer<typeof resolveSchema>) {
    const isPlatform = principal.type === 'user' && principal.role === 'PLATFORM_ADMIN';
    return this.reconciliation.resolve(id, body.note, principal, isPlatform ? undefined : requireSchoolId(principal));
  }
}
