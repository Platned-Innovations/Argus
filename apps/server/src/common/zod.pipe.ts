import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { type z } from 'zod';

/** Validates and normalises a request body/query against a shared zod schema. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    throw new BadRequestException({
      statusCode: 400,
      message: 'Validation failed',
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
}
