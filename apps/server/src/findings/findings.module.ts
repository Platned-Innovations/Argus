import { Module } from '@nestjs/common';
import { ScanningModule } from '../scanning/scanning.module';
import { FindingsController, PackagesController, SuppressionsController } from './findings.controller';
import { FindingsService } from './findings.service';
import { IntelController } from './intel.controller';

@Module({
  imports: [ScanningModule],
  controllers: [FindingsController, PackagesController, SuppressionsController, IntelController],
  providers: [FindingsService],
  exports: [FindingsService],
})
export class FindingsModule {}
