import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ScanningModule } from '../scanning/scanning.module';
import { AdvisoriesService } from './advisories.service';
import { IntelAdminController } from './intel-admin.controller';
import { NewsService } from './news.service';
import { RematchService } from './rematch.service';

/** Threat intelligence: security news, AI advisory extraction and review, Argus advisories, continuous re-matching. */
@Module({
  imports: [ScanningModule, AiModule],
  controllers: [IntelAdminController],
  providers: [RematchService, NewsService, AdvisoriesService],
})
export class IntelModule {}
