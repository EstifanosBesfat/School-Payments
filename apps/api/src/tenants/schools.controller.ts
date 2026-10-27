import {
  type CreateSchoolInput,
  createSchoolSchema,
  type CreateStaffUserInput,
  createStaffUserSchema,
  paginationSchema,
  type PayoutAccountInput,
  payoutAccountSchema,
  phoneSchema,
  type SchoolSettlementInput,
  schoolSettlementSchema,
} from '@payment/shared';
import { z } from 'zod';
import { CurrentPrincipal, Roles } from '../common/decorators';
import { type Principal, requireSchoolId } from '../common/principal';
import { ZodValidationPipe, zodBody } from '../common/zod-validation.pipe';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { LedgerService } from '../ledger/ledger.service';
import { SchoolsService } from './schools.service';

const statusSchema = z.object({ status: z.enum(['ONBOARDING', 'ACTIVE', 'SUSPENDED']) });
const updateSchoolSchema = z.object({
  smsSenderName: z.string().trim().max(11).optional(),
  logoUrl: z.url().optional(),
  contactEmail: z.email().optional(),
  contactPhone: phoneSchema.optional(),
  city: z.string().trim().max(100).optional(),
});
const activeSchema = z.object({ isActive: z.boolean() });

@ApiTags('platform')
@ApiBearerAuth()
@Controller('schools')
export class PlatformSchoolsController {
  constructor(private readonly schools: SchoolsService) {}

  @Roles('PLATFORM_ADMIN')
  @Post()
  create(@Body(zodBody(createSchoolSchema)) body: CreateSchoolInput, @CurrentPrincipal() principal: Principal) {
    return this.schools.create(body, principal);
  }

  @Roles('PLATFORM_ADMIN')
  @Get()
  list() {
    return this.schools.list();
  }

  @Roles('PLATFORM_ADMIN')
  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body(zodBody(statusSchema)) body: z.infer<typeof statusSchema>, @CurrentPrincipal() principal: Principal) {
    return this.schools.setStatus(id, body.status, principal);
  }
}

@ApiTags('school')
@ApiBearerAuth()
@Controller('school')
export class MySchoolController {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly schools: SchoolsService,
    private readonly ledger: LedgerService,
  ) {}

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @Get()
  get(@CurrentPrincipal() principal: Principal) {
    return this.schools.get(requireSchoolId(principal));
  }

  @Roles('SCHOOL_ADMIN')
  @Patch()
  update(@CurrentPrincipal() principal: Principal, @Body(zodBody(updateSchoolSchema)) body: z.infer<typeof updateSchoolSchema>) {
    return this.schools.update(requireSchoolId(principal), body, principal);
  }

  @Roles('SCHOOL_ADMIN')
  @Get('banks')
  banks() {
    return this.schools.listBanks();
  }

  @Roles('SCHOOL_ADMIN')
  @Put('settlement')
  settlement(@CurrentPrincipal() principal: Principal, @Body(zodBody(schoolSettlementSchema)) body: SchoolSettlementInput) {
    return this.schools.configureSettlement(requireSchoolId(principal), body, principal, {
      type: this.env.PLATFORM_FEE_TYPE,
      value: this.env.PLATFORM_FEE_VALUE,
    });
  }

  @Roles('SCHOOL_ADMIN')
  @Get('payout')
  async getPayout(@CurrentPrincipal() principal: Principal) {
    const school = await this.schools.get(requireSchoolId(principal));
    const full = await this.schools.getFullSchool(requireSchoolId(principal));
    return this.schools.getPayoutSummary(full);
  }

  @Roles('SCHOOL_ADMIN')
  @Put('payout')
  savePayout(@CurrentPrincipal() principal: Principal, @Body(zodBody(payoutAccountSchema)) body: PayoutAccountInput) {
    return this.schools.savePayoutAccount(requireSchoolId(principal), body, principal);
  }

  @Roles('SCHOOL_ADMIN')
  @Get('users')
  staff(@CurrentPrincipal() principal: Principal) {
    return this.schools.listStaff(requireSchoolId(principal));
  }

  @Roles('SCHOOL_ADMIN')
  @Post('users')
  createStaff(@CurrentPrincipal() principal: Principal, @Body(zodBody(createStaffUserSchema)) body: CreateStaffUserInput) {
    return this.schools.createStaff(requireSchoolId(principal), body, principal);
  }

  @Roles('SCHOOL_ADMIN')
  @Patch('users/:id')
  setStaffActive(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(zodBody(activeSchema)) body: z.infer<typeof activeSchema>) {
    return this.schools.setStaffActive(requireSchoolId(principal), id, body.isActive, principal);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @Get('ledger/balances')
  balances(@CurrentPrincipal() principal: Principal) {
    return this.ledger.balances(requireSchoolId(principal));
  }

  @Roles('SCHOOL_ADMIN')
  @Get('audit-log')
  auditLog(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(paginationSchema)) query: z.infer<typeof paginationSchema>) {
    return this.schools.auditLog(requireSchoolId(principal), query.page, query.pageSize);
  }
}
