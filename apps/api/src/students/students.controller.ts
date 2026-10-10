import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { type CreateStudentInput, createStudentSchema, guardianSchema, importStudentsSchema, paginationSchema } from '@payment/shared';
import { z } from 'zod';
import { ApiKeyScopes, CurrentPrincipal, Roles } from '../common/decorators';
import { type Principal, requireSchoolId } from '../common/principal';
import { ZodValidationPipe, zodBody } from '../common/zod-validation.pipe';
import { StudentsService } from './students.service';

const listQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  grade: z.string().trim().max(20).optional(),
  section: z.string().trim().max(20).optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

const updateStudentSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  grade: z.string().trim().min(1).max(20).optional(),
  section: z.string().trim().max(20).nullable().optional(),
  isActive: z.boolean().optional(),
  guardians: z.array(guardianSchema).min(1).max(5).optional(),
});

@ApiTags('students')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('students:read')
  @Get()
  list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>) {
    return this.students.list(requireSchoolId(principal), query);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('students:read')
  @Get('grades')
  grades(@CurrentPrincipal() principal: Principal) {
    return this.students.grades(requireSchoolId(principal));
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('students:read')
  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.students.get(requireSchoolId(principal), id);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('students:write')
  @Post()
  create(@CurrentPrincipal() principal: Principal, @Body(zodBody(createStudentSchema)) body: CreateStudentInput) {
    return this.students.create(requireSchoolId(principal), body, principal);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('students:write')
  @Post('import')
  import(@CurrentPrincipal() principal: Principal, @Body(zodBody(importStudentsSchema)) body: z.infer<typeof importStudentsSchema>) {
    return this.students.import(requireSchoolId(principal), body.students, principal);
  }

  @Roles('SCHOOL_ADMIN', 'ACCOUNTANT')
  @ApiKeyScopes('students:write')
  @Patch(':id')
  update(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(zodBody(updateStudentSchema)) body: z.infer<typeof updateStudentSchema>) {
    return this.students.update(requireSchoolId(principal), id, body, principal);
  }
}
