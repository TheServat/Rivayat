import { describe, expect, it } from 'vitest';
import { MemoryLogger, isErr } from '@rv/shared-kernel';
import { StructuredCall } from '@rv/prompt-kit';

import { FakeStructuredBackend, respondError, respondJson } from '../__fixtures__/fakes';
import { deterministicIds, fixedClock, testDeps } from '../__fixtures__/builders';
import { FixedStageBackends } from '../routing/stage-backends';
import { SCREENWRITER } from '../roles/index';
import {
  bulletList,
  inlineList,
  normaliseForComparison,
  orElse,
  orderedList,
  slugify,
} from './format';
import { TraceLog, runRoleCall } from './stage-call';
import { z } from 'zod';

describe('prompt formatting', () => {
  it('names the empty case instead of leaving a blank slot', () => {
    expect(inlineList([])).toBe('none recorded');
    expect(bulletList([])).toBe('none recorded');
    expect(orderedList([])).toBe('none');
    expect(inlineList(['  ', ''])).toBe('none recorded');
  });

  it('drops blank entries but keeps the rest', () => {
    expect(inlineList(['a', '  ', 'b'])).toBe('a, b');
    expect(bulletList(['a', 'b'])).toBe('- a\n- b');
    expect(orderedList(['a', 'b'])).toBe('1. a\n2. b');
  });

  it('substitutes a stated placeholder for an absent value', () => {
    expect(orElse(undefined, 'not stated')).toBe('not stated');
    expect(orElse(null, 'not stated')).toBe('not stated');
    expect(orElse('   ', 'not stated')).toBe('not stated');
    expect(orElse(' kept ', 'not stated')).toBe('kept');
  });

  it('compares text by content, not by line wrapping', () => {
    expect(normaliseForComparison('  A  B\nC ')).toBe('a b c');
    expect(normaliseForComparison('a b c')).toBe(normaliseForComparison('A\nB\tC'));
  });

  it('slugs a label, and never to nothing', () => {
    expect(slugify('Wardrobe: Winter!')).toBe('wardrobe-winter');
    expect(slugify('مهتاب')).toBe('unnamed');
    expect(slugify('مهتاب', 'character')).toBe('character');
    expect(slugify('---')).toBe('unnamed');
  });
});

describe('runRoleCall', () => {
  const schema = z.strictObject({ ok: z.boolean() });

  it("sends the role's system prompt and the caller's user turn, and nothing else", async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson({ ok: true })] });
    const outcome = await runRoleCall(testDeps(backend), {
      role: SCREENWRITER,
      schemaName: 'Probe',
      schema,
      user: 'the user turn',
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.value).toEqual({ ok: true });
    expect(backend.systemPromptAt(0)).toBe(SCREENWRITER.systemPrompt);
    expect(backend.userPromptAt(0)).toBe('the user turn');
    expect(backend.requests[0]?.temperature).toBe(SCREENWRITER.temperature);
  });

  it('lets a caller override the role temperature deliberately', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson({ ok: true })] });
    await runRoleCall(testDeps(backend), {
      role: SCREENWRITER,
      schemaName: 'Probe',
      schema,
      user: 'x',
      temperature: 0,
      maxRepairs: 0,
      maxOutputTokens: 512,
    });
    expect(backend.requests[0]?.temperature).toBe(0);
    expect(backend.requests[0]?.maxOutputTokens).toBe(512);
  });

  it('fails without calling anything when no backend can serve the stage', async () => {
    const outcome = await runRoleCall(
      {
        structured: new StructuredCall({ clock: fixedClock() }),
        backends: new FixedStageBackends([]),
        clock: fixedClock(),
        ids: deterministicIds(),
      },
      { role: SCREENWRITER, schemaName: 'Probe', schema, user: 'x' },
    );
    expect(isErr(outcome)).toBe(true);
  });

  it('logs the trace of a failed call rather than discarding it', async () => {
    const logger = new MemoryLogger();
    const backend = new FakeStructuredBackend({ script: [respondError(), respondError()] });
    const outcome = await runRoleCall(
      { ...testDeps(backend), logger },
      { role: SCREENWRITER, schemaName: 'Probe', schema, user: 'x' },
    );

    expect(isErr(outcome)).toBe(true);
    expect(logger.records.some((record) => record.message.includes('role call failed'))).toBe(true);
  });

  it('passes prior turns through as context', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson({ ok: true })] });
    await runRoleCall(testDeps(backend), {
      role: SCREENWRITER,
      schemaName: 'Probe',
      schema,
      user: 'x',
      context: [{ role: 'assistant', content: 'an earlier draft' }],
    });
    expect(backend.promptAt(0)).toContain('an earlier draft');
  });
});

describe('TraceLog', () => {
  it("accumulates every call's trace and totals the spend", async () => {
    const backend = new FakeStructuredBackend({
      script: [respondJson({ ok: true }), respondJson({ ok: true })],
    });
    const deps = testDeps(backend);
    const schema = z.strictObject({ ok: z.boolean() });
    const log = new TraceLog();

    for (const _ of [1, 2]) {
      const outcome = await runRoleCall(deps, {
        role: SCREENWRITER,
        schemaName: 'Probe',
        schema,
        user: 'x',
      });
      if (isErr(outcome)) throw new Error('expected success');
      log.add(outcome.value.trace);
    }

    expect(log.traces).toHaveLength(2);
    expect(log.costNanoUsd).toBe(2_000);
  });

  it('takes a batch of traces at once', () => {
    const log = new TraceLog();
    log.addAll([]);
    expect(log.traces).toEqual([]);
    expect(log.costNanoUsd).toBe(0);
  });
});
