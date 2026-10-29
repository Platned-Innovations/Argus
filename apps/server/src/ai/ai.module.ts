import { Module } from '@nestjs/common';
import { AiSettingsController, AiStatusController } from './ai.controller';
import { AiService } from './ai.service';

/** AI provider access with its guardrails. Feature modules (tickets, scans) build prompts and call AiService. */
@Module({
  controllers: [AiStatusController, AiSettingsController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
