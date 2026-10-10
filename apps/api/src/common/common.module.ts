import { Global, Module } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../config/config.module';
import { SecretBox } from './crypto.util';

@Global()
@Module({
  providers: [
    {
      provide: SecretBox,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => new SecretBox(env.DATA_ENCRYPTION_KEY),
    },
  ],
  exports: [SecretBox],
})
export class CommonModule {}
