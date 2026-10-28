import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus } from '@nestjs/common';
import { DuplicateKeyError } from '@argus/data';
import { type Response } from 'express';

@Catch(DuplicateKeyError)
export class DuplicateKeyFilter implements ExceptionFilter {
  catch(err: DuplicateKeyError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.CONFLICT)
      .json({ statusCode: HttpStatus.CONFLICT, message: `A record with this ${err.field} already exists.`, code: 'DUPLICATE' });
  }
}
