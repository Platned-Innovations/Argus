import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';

/** Credential inventory with expiry notices and the Microsoft Entra ID import. */
@Module({
  imports: [ReportsModule],
  controllers: [CredentialsController],
  providers: [CredentialsService],
})
export class CredentialsModule {}
