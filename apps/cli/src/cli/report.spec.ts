import { describe, expect, it } from 'vitest';

import { NotFoundError, ValidationError } from '@rv/shared-kernel';

import { EXIT } from './exit';
import { BufferIo, ProcessIo } from './io';
import { codeOf, emitJson, emitJsonFailure, fail, messageOf, usageError } from './report';

describe('the JSON envelope', () => {
  it('is the same shape on success whatever the payload is', () => {
    const io = new BufferIo();
    emitJson(io, { anything: 1 });
    expect(JSON.parse(io.outText)).toEqual({ ok: true, code: null, data: { anything: 1 } });
  });

  it('carries a machine-stable code and the error context on failure', () => {
    const io = new BufferIo();
    emitJsonFailure(io, new NotFoundError('project', 'prj_x'));
    const envelope = JSON.parse(io.outText) as {
      ok: boolean;
      code: string;
      context: { resource: string; id: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('NOT_FOUND');
    expect(envelope.context).toMatchObject({ resource: 'project', id: 'prj_x' });
  });

  it('goes to stdout even on the error path, so `| jq` still parses', () => {
    const io = new BufferIo();
    emitJsonFailure(io, new ValidationError({ message: 'nope' }));
    expect(io.outText).not.toBe('');
    expect(io.errText).toBe('');
  });

  it('omits an empty context rather than emitting {}', () => {
    const io = new BufferIo();
    emitJsonFailure(io, new ValidationError({ message: 'nope' }));
    expect(JSON.parse(io.outText)).not.toHaveProperty('context');
  });
});

describe('fail', () => {
  it('writes a human line to stderr and returns the failure code', () => {
    const io = new BufferIo();
    const code = fail(io, new NotFoundError('project', 'prj_x'), { json: false });
    expect(code).toBe(EXIT.failed);
    expect(io.errText).toContain('NOT_FOUND');
    expect(io.outText).toBe('');
  });

  it('honours an overridden exit code, so a finding is not reported as a failure', () => {
    const io = new BufferIo();
    expect(fail(io, new Error('x'), { json: false, exit: EXIT.findings })).toBe(EXIT.findings);
  });
});

describe('usageError', () => {
  it('returns 2 and says what to do', () => {
    const io = new BufferIo();
    expect(usageError(io, 'Which episode?', false)).toBe(EXIT.usage);
    expect(io.errText).toContain('Which episode?');
  });

  it('is still a parseable envelope under --json', () => {
    const io = new BufferIo();
    usageError(io, 'Which episode?', true);
    expect((JSON.parse(io.outText) as { code: string }).code).toBe('VALIDATION_FAILED');
  });
});

describe('codeOf / messageOf', () => {
  it('falls back to internal for something that is not an AppError', () => {
    expect(codeOf(new Error('boom'))).toBe('internal');
    expect(messageOf(new Error('boom'))).toBe('boom');
  });

  it('survives a thrown non-Error', () => {
    expect(messageOf('a string')).toBe('a string');
    expect(messageOf(undefined)).toBe('undefined');
  });
});

describe('ProcessIo', () => {
  it('writes a newline-terminated line to each stream', () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = new ProcessIo(
      { write: (chunk: string) => out.push(chunk) } as unknown as NodeJS.WritableStream,
      { write: (chunk: string) => err.push(chunk) } as unknown as NodeJS.WritableStream,
    );
    io.out('hello');
    io.err('problem');
    io.out();
    expect(out).toEqual(['hello\n', '\n']);
    expect(err).toEqual(['problem\n']);
  });
});
