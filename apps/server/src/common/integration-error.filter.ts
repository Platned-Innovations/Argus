import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus } from '@nestjs/common';
import { type Response } from 'express';
import { AiOutputError } from '../ai/providers';
import { IntegrationError } from '../integrations/outbound';

/** A third party (Jira, an AI provider, a mail server) failed: report it as a bad gateway with its safe message. */
@Catch(IntegrationError, AiOutputError)
export class IntegrationErrorFilter implements ExceptionFilter {
  catch(err: IntegrationError | AiOutputError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.BAD_GATEWAY)
      .json({ statusCode: HttpStatus.BAD_GATEWAY, message: err.message, code: err instanceof AiOutputError ? 'AI_OUTPUT' : 'INTEGRATION' });
  }
}
