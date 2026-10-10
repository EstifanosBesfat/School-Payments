import { Global, Module } from '@nestjs/common';
import { EmailService } from './email/email.service';
import { NotificationsService } from './notifications.service';
import { SmsService } from './sms/sms.service';

@Global()
@Module({
  providers: [SmsService, EmailService, NotificationsService],
  exports: [SmsService, EmailService, NotificationsService],
})
export class NotificationsModule {}
