import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../cli/args';
import { EXIT } from '../cli/exit';
import {
  irWithCycle,
  irWithDanglingTrack,
  irWithLateKeyframe,
  irWithSilentBehaviour,
  validIr,
} from '../__fixtures__/animation';
import { jsonOut, makeHarness, type Harness } from '../__fixtures__/harness';
import { animLintCommand, lintAnimationDocument } from './anim-lint';

describe('lintAnimationDocument', () => {
  it('passes a valid document with no diagnostics', () => {
    const report = lintAnimationDocument(validIr());
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
  });

  it('reports a dangling track reference as an error, with the path', () => {
    const report = lintAnimationDocument(irWithDanglingTrack());
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.diagnostics.map((d) => d.path)).toContain('tracks');
    expect(report.diagnostics.every((d) => d.severity === 'error')).toBe(true);
  });

  it('reports a parent cycle rather than hanging', () => {
    const report = lintAnimationDocument(irWithCycle());
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.diagnostics.some((d) => /cycle/i.test(d.message))).toBe(true);
  });

  it('warns, but does not error, on a keyframe past the end of the timeline', () => {
    const report = lintAnimationDocument(irWithLateKeyframe());
    expect(report.errorCount).toBe(0);
    const late = report.diagnostics.find((d) => d.code === 'track.keyframe-past-end');
    expect(late?.severity).toBe('warning');
    expect(late?.path).toBe('tracks.0.keyframes.2.timeMs');
  });

  it('warns about a behaviour that can never contribute', () => {
    const report = lintAnimationDocument(irWithSilentBehaviour());
    const codes = report.diagnostics.map((d) => d.code);
    expect(codes).toContain('behaviour.zero-weight');
    expect(codes).toContain('behaviour.starts-past-end');
  });

  it('reports a document that is not an IR at all as a schema error', () => {
    const report = lintAnimationDocument({ hello: 'world' });
    expect(report.errorCount).toBeGreaterThan(0);
  });
});

describe('rv anim lint', () => {
  let harness: Harness;
  let dir: string;

  beforeEach(async () => {
    harness = await makeHarness();
    dir = await mkdtemp(join(tmpdir(), 'rv-lint-'));
  });
  afterEach(async () => {
    await harness.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, body: unknown): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return path;
  }

  it('exits 0 on a clean file', async () => {
    const path = await write('good.rvanim.json', validIr());
    const code = await animLintCommand.run(harness.context, parseArgs([path]));
    expect(code).toBe(EXIT.ok);
    expect(harness.io.outText).toContain('clean');
  });

  it('exits 3 - findings, not failure - on a broken file', async () => {
    const path = await write('broken.rvanim.json', irWithDanglingTrack());
    const code = await animLintCommand.run(harness.context, parseArgs([path]));
    expect(code).toBe(EXIT.findings);
    expect(harness.io.outText).toContain('error(s)');
  });

  it('exits 0 on warnings, and 3 on the same file under --strict', async () => {
    const path = await write('warn.rvanim.json', irWithLateKeyframe());
    expect(await animLintCommand.run(harness.context, parseArgs([path]))).toBe(EXIT.ok);
    expect(
      await animLintCommand.run(
        harness.context,
        parseArgs([path, '--strict'], { booleans: ['strict'] }),
      ),
    ).toBe(EXIT.findings);
  });

  it('exits 1 when the file does not exist - the tool failed, the file did not', async () => {
    const code = await animLintCommand.run(harness.context, parseArgs([join(dir, 'nope.json')]));
    expect(code).toBe(EXIT.failed);
  });

  it('reports malformed JSON as a diagnostic rather than a crash', async () => {
    const path = await write('bad.json', '{ not json');
    const code = await animLintCommand.run(
      harness.context,
      parseArgs([path, '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.findings);
    const envelope = jsonOut(harness.io);
    const data = envelope.data as { diagnostics: { code: string }[] };
    expect(data.diagnostics[0]?.code).toBe('json.parse');
  });

  it('exits 2 when no file is named', async () => {
    const code = await animLintCommand.run(harness.context, parseArgs([]));
    expect(code).toBe(EXIT.usage);
  });

  it('emits a machine-readable envelope under --json', async () => {
    const path = await write('good.rvanim.json', validIr());
    await animLintCommand.run(harness.context, parseArgs([path, '--json'], { booleans: ['json'] }));
    const envelope = jsonOut(harness.io);
    expect(envelope.ok).toBe(true);
    expect((envelope.data as { errorCount: number }).errorCount).toBe(0);
  });
});
