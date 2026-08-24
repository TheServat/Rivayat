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
  NODE_B,
  irWithLimbDraggedOffTheBody,
  irWithNoDeclaredSizes,
  irWithPartThatPops,
  irWithSubjectOffCanvas,
  irWithSilentBehaviour,
  irWithWingPivotedAtTheShoulder,
  irWithWingPivotedOffTheBody,
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

describe('the geometry pass', () => {
  it('names the node, the parent and the distance when a joint is rigged to open', () => {
    const report = lintAnimationDocument(irWithWingPivotedOffTheBody());
    const finding = report.diagnostics.find((d) => d.code === 'joint.pivot-outside-parent');

    expect(finding?.severity).toBe('error');
    expect(finding?.path).toBe('nodes.1.transform.anchor');
    expect(finding?.message).toContain('"wing-l"');
    expect(finding?.message).toContain('"bird"');
    expect(report.errorCount).toBeGreaterThan(0);
  });

  it('goes quiet on the same two nodes once the wing pivots at its shoulder', () => {
    const report = lintAnimationDocument(irWithWingPivotedAtTheShoulder());
    expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(report.geometry?.joints).toBe(1);
  });

  it('reports what it measured, so a clean run is a claim about something', () => {
    const report = lintAnimationDocument(irWithWingPivotedAtTheShoulder());
    expect(report.geometry).toEqual({
      measuredNodes: 2,
      unmeasuredNodes: 0,
      joints: 1,
      sampledFrames: 24,
      toleranceScenePx: 0.5,
    });
  });

  it('warns rather than passing silently when no node declares a size', () => {
    const report = lintAnimationDocument(irWithNoDeclaredSizes());
    const warning = report.diagnostics.find((d) => d.code === 'geometry.nothing-measured');
    expect(warning?.severity).toBe('warning');
    expect(report.geometry?.measuredNodes).toBe(0);
  });

  it('reports no geometry at all for a document that did not parse', () => {
    expect(lintAnimationDocument({ hello: 'world' }).geometry).toBeUndefined();
  });
});

describe('rv anim lint, on a rig that draws a hole', () => {
  let harness: Harness;
  let dir: string;

  beforeEach(async () => {
    harness = await makeHarness();
    dir = await mkdtemp(join(tmpdir(), 'rv-anim-geo-'));
  });

  afterEach(async () => {
    await harness.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  async function lint(document: unknown, ...extra: string[]): Promise<number> {
    const file = join(dir, 'scene.rvanim.json');
    await writeFile(file, JSON.stringify(document), 'utf8');
    return animLintCommand.run(
      harness.context,
      parseArgs([file, ...extra], { booleans: ['json', 'strict'] }),
    );
  }

  it('exits with findings and carries the geometry summary into the JSON report', async () => {
    const code = await lint(irWithWingPivotedOffTheBody(), '--json');
    expect(code).toBe(EXIT.findings);

    const payload = jsonOut(harness.io).data as {
      geometry: { measuredNodes: number; joints: number };
      diagnostics: { code: string }[];
    };
    expect(payload.diagnostics.map((d) => d.code)).toContain('joint.pivot-outside-parent');
    expect(payload.geometry).toMatchObject({ measuredNodes: 2, joints: 1 });
  });

  it('exits clean on the shoulder-pivoted rig and says how much it looked at', async () => {
    const code = await lint(irWithWingPivotedAtTheShoulder());
    expect(code).toBe(EXIT.ok);
    expect(harness.io.outText).toContain('2 of 2 nodes measured');
  });
});

describe('the geometry pass, on the checks a document cannot ask for by itself', () => {
  it('names the gap and the frame when a part has come away from its parent', () => {
    const report = lintAnimationDocument(irWithLimbDraggedOffTheBody());
    const opened = report.diagnostics.find((d) => d.code === 'joint.opened');

    expect(opened?.severity).toBe('error');
    expect(opened?.path).toBe('nodes.1.transform.position');
    expect(opened?.message).toContain('"limb"');
    expect(opened?.message).toContain('"trunk"');
    expect(opened?.message).toContain('frame 23');
  });

  it('reports a part that stops being drawn, in a unit that is not pixels', () => {
    const report = lintAnimationDocument(irWithPartThatPops());
    const popped = report.diagnostics.find((d) => d.code === 'silhouette.area-discontinuity');

    expect(popped?.severity).toBe('error');
    expect(popped?.path).toBe('nodes.1.transform');
    // A ratio carries no unit, and the sentence must not invent one.
    expect(popped?.message).not.toContain('scene px');
    expect(popped?.message).toContain('pop rather than motion');
  });

  it('says nothing about the scene box or the camera frame unless asked', () => {
    const report = lintAnimationDocument(irWithSubjectOffCanvas());
    expect(report.diagnostics.map((d) => d.code)).not.toContain('scene.out-of-bounds');
    expect(report.diagnostics.map((d) => d.code)).not.toContain('camera.focus-out-of-frame');
  });

  it('reports a node that left the scene box, once a caller says which nodes must stay', () => {
    const report = lintAnimationDocument(irWithSubjectOffCanvas(), {
      geometry: { containedNodeIds: [NODE_B] },
    });
    const out = report.diagnostics.find((d) => d.code === 'scene.out-of-bounds');
    expect(out?.message).toContain('"disc"');
    expect(out?.message).toContain('outside the scene box');
  });

  it('reports a camera that has lost its focus target, once asked to look', () => {
    const report = lintAnimationDocument(irWithSubjectOffCanvas(), {
      geometry: { checkCameraFocus: true },
    });
    const lost = report.diagnostics.find((d) => d.code === 'camera.focus-out-of-frame');
    expect(lost?.message).toContain('"disc"');
    expect(lost?.message).toContain('outside the frame');
  });
});
