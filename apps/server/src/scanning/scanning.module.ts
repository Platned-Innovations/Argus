import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ScanAiTriage } from './ai-triage';
import { IntelService } from './intel.service';
import { ScanPipeline } from './scan-pipeline.service';

@Module({
  imports: [AiModule],
  providers: [IntelService, ScanPipeline, ScanAiTriage],
  exports: [IntelService, ScanPipeline],
})
export class ScanningModule {}
