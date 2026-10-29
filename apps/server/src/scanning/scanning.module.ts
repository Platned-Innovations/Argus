import { Module } from '@nestjs/common';
import { IntelService } from './intel.service';
import { ScanPipeline } from './scan-pipeline.service';

@Module({
  providers: [IntelService, ScanPipeline],
  exports: [IntelService, ScanPipeline],
})
export class ScanningModule {}
