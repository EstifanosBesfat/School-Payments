import { Module } from '@nestjs/common';
import { MySchoolController, PlatformSchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';

@Module({
  controllers: [PlatformSchoolsController, MySchoolController],
  providers: [SchoolsService],
  exports: [SchoolsService],
})
export class TenantsModule {}
