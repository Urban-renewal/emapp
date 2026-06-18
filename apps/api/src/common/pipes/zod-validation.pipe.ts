import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

import { hasUnstorableText } from './unstorable-text';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    if (hasUnstorableText(value)) {
      throw new BadRequestException({
        error: {
          code: 'validation_error',
          details: { _: ['contains NUL or invalid UTF-8'] },
        },
      });
    }
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: { code: 'validation_error', details: result.error.flatten().fieldErrors },
      });
    }
    return result.data;
  }
}
