import { Module } from '@nestjs/common';
import { SourcesModule } from '../sources/sources.module';
import { ReposController, ScansController } from './repos.controller';
import { ReposService } from './repos.service';
import { ScanExecutor } from './scan-executor.service';
import { ScansService } from './scans.service';
import { SchedulerService } from './scheduler.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [SourcesModule],
  controllers: [ReposController, ScansController, WebhooksController],
  providers: [ReposService, ScansService, ScanExecutor, SchedulerService],
})
export class ScansModule {}
