/**
 * The pipe, and the two ways it can find a schema.
 *
 * The per-parameter form is what every controller uses, because it works under every
 * TypeScript transform this repo runs - oxc and esbuild emit no `design:paramtypes`, so
 * a pipe that only read the metatype would be a silent no-op in the test suite that is
 * supposed to prove it works. The metatype form is kept for the day a `nest build`
 * pipeline introduces DTO classes, and is tested so it does not rot.
 */

import type { ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ZodValidationPipe, toValidationError } from './zod-validation.pipe';

const Body = z.object({
  name: z.string().min(1),
  count: z.number().int().min(0).default(0),
  nested: z.object({ tag: z.string() }).optional(),
});

const BODY_META: ArgumentMetadata = { type: 'body', metatype: undefined, data: undefined };

describe('ZodValidationPipe', () => {
  it('parses and returns the schema output, not the raw input', () => {
    const pipe = new ZodValidationPipe(Body);
    // `count` has a default, so the output differs from the input. A pipe that
    // returned the input would hand the handler a shape its type says cannot happen.
    expect(pipe.transform({ name: 'fox' }, BODY_META)).toEqual({ name: 'fox', count: 0 });
  });

  it('reports every failing field, with its dotted path', () => {
    const pipe = new ZodValidationPipe(Body);
    let caught: unknown;
    try {
      pipe.transform({ name: '', count: 1.5, nested: { tag: 9 } }, BODY_META);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    const issues = (caught as { context: { issues: { path: string }[] } }).context.issues;
    expect(issues.map((issue) => issue.path).sort()).toEqual(['count', 'name', 'nested.tag']);
  });

  it('names the argument that failed, so a 400 says where to look', () => {
    const pipe = new ZodValidationPipe(z.string());
    let caught: unknown;
    try {
      pipe.transform(42, { type: 'param', metatype: undefined, data: 'id' });
    } catch (error) {
      caught = error;
    }
    expect((caught as { message: string }).message).toContain('param.id');
  });

  it('uses an empty path for a root-level failure rather than omitting it', () => {
    const error = toValidationError(z.string().safeParse(42).error ?? new z.ZodError([]), 'body');
    const issues = error.context.issues as { path: string }[];
    expect(issues[0]?.path).toBe('');
  });

  describe('the globally-registered form', () => {
    it('passes an argument through when nothing declares a schema', () => {
      const pipe = ZodValidationPipe.passthrough();
      const value = { anything: true };
      expect(pipe.transform(value, BODY_META)).toBe(value);
    });

    it('validates a metatype that carries its own schema', () => {
      class BodyDto {
        static readonly zodSchema = Body;
      }
      const pipe = ZodValidationPipe.passthrough();
      const parsed = pipe.transform({ name: 'fox' }, { ...BODY_META, metatype: BodyDto });
      expect(parsed).toEqual({ name: 'fox', count: 0 });
    });

    it('ignores a metatype that is a plain class', () => {
      class Plain {}
      const pipe = ZodValidationPipe.passthrough();
      const value = { untouched: true };
      expect(pipe.transform(value, { ...BODY_META, metatype: Plain })).toBe(value);
    });
  });
});
