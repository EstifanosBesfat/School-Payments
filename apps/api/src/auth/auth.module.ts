import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { ApiKeysService } from './api-keys.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => ({
        secret: env.JWT_ACCESS_SECRET,
        signOptions: { algorithm: 'HS256', issuer: 'school-payments-api' },
        verifyOptions: { algorithms: ['HS256'], issuer: 'school-payments-api' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, ApiKeysService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService, ApiKeysService],
})
export class AuthModule {}
