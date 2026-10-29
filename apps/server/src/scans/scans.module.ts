import { Module } from '@nestjs/common';
import { ScanningModule } from '../scanning/scanning.module';
import { SourcesModule } from '../sources/sources.module';
import { ActivityController, ReposController, ScansController } from './repos.controller';
import { ReposService } from './repos.service';
import { ScanExecutor } from './scan-executor.service';
import { ScansService } from './scans.service';
import { SchedulerService } from './scheduler.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [SourcesModule, ScanningModule],
  controllers: [ReposController, ScansController, ActivityController, WebhooksController],
  providers: [ReposService, ScansService, ScanExecutor, SchedulerService],
})
export class ScansModule {}
