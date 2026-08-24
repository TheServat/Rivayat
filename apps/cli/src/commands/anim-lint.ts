/**
 * `rv anim lint <file>` - precise diagnostics, non-zero exit.
 *
 * The M3 demo line is `pnpm rv anim lint fixtures/broken.rvanim.json`, and "precise" is
 * the whole requirement: a linter that says "invalid IR" has told you nothing you did
 * not already know from the render failing. Every diagnostic here carries a JSON path
 * you can jump to, a stable code you can grep for, and a sentence that names the thing
 * that is wrong rather than the rule that caught it.
 *
 * Three layers, and the split matters. **Schema errors** come from `AnimationIR` in
 * `@rv/contracts` - duplicate node ids, unknown parents, hierarchy cycles, tracks and
 * behaviours pointing at nothing, part/bone overrides of a non-instance. Those are the
 * schema's own `superRefine` checks and this file does not restate one of them, because
 * a second implementation of "is this IR valid" is a second implementation to disagree.
 * **Warnings** are the things the schema cannot reasonably reject but a renderer will
 * silently swallow: a keyframe past the end of the timeline, a behaviour window outside
 * it, two nodes with the same name, a marker nobody will ever reach.
 *
 * **Geometry errors** are the third layer, and they exist because the first two are not
 * enough. A document can satisfy every schema rule, render a bit-reproducible frame, and
 * still put a triangular hole through a bird - because nothing above this line looks at
 * the *picture*. `checkGeometry` in `@rv/anim-engine` samples the clip and measures each
 * node's silhouette against its neighbours, so "the wing came away from the body at
 * 340 ms" arrives as a diagnostic with a node, a frame and a distance instead of as
 * something a human has to notice in a finished video.
 *
 * They are errors rather than warnings because a broken picture is not something a
 * renderer swallows - it is something a viewer sees. Geometry is measured only for nodes
 * whose size the document declares, and when nothing is measurable the report says so out
 * loud: a gate that inspected nothing must never be mistaken for a gate that found
 * nothing.
 *
 * Exit code 3, not 1: the tool worked perfectly and the file did not. A CI job that
 * retries on 1 must not retry this.
 */

import { readFile } from 'node:fs/promises';

import {
  checkGeometry,
  type GeometryCheckOptions,
  type GeometryFinding,
  type GeometryReport,
} from '@rv/anim-engine';
import { AnimationIR } from '@rv/contracts';
import { NotFoundError, must } from '@rv/shared-kernel';

import { flag, positional, type ParsedArgs } from '../cli/args';
import type { Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, emitJsonFailure, usageError } from '../cli/report';
import { table } from '../cli/text';

export const DIAGNOSTIC_SEVERITIES = ['error', 'warning'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  /** Stable and greppable. Never derived from the message. */
  readonly code: string;
  /** Dotted JSON path into the document, e.g. `nodes.3.parentId`. */
  readonly path: string;
  readonly message: string;
}

export interface LintReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly errorCount: number;
  readonly warningCount: number;
  /**
   * What the geometry pass actually looked at.
   *
   * Present whenever the document parsed, absent when it did not. `measuredNodes: 0` is
   * the shape of "this file declares no sizes, so nothing was measured", which a caller
   * has to be able to tell apart from "measured everything, found nothing".
   */
  readonly geometry?: {
    readonly measuredNodes: number;
    readonly unmeasuredNodes: number;
    readonly joints: number;
    readonly sampledFrames: number;
    readonly toleranceScenePx: number;
  };
}

export interface LintOptions {
  /**
   * Passed through to `checkGeometry`.
   *
   * Two of the geometry checks need something the document cannot supply on its own: a
   * scene box to be contained by, and permission to judge the camera's focus. Both are
   * off unless a caller asks, because "outside the scene box" is normal for a sky and
   * because `apps/cli` and `@rv/render-engine` do not currently agree on where scene
   * space's origin is - a linter is the wrong place to settle that.
   */
  readonly geometry?: GeometryCheckOptions;
}

/**
 * Lints a parsed JSON document.
 *
 * Separate from the file reading so the whole of the interesting behaviour is a pure
 * function of a value - which is what lets the specs cover every diagnostic without a
 * temporary directory.
 */
export function lintAnimationDocument(document: unknown, options: LintOptions = {}): LintReport {
  const parsed = AnimationIR.safeParse(document);
  if (!parsed.success) {
    const diagnostics = parsed.error.issues.map<Diagnostic>((issue) => ({
      severity: 'error',
      code: `schema.${issue.code}`,
      path: issue.path.length === 0 ? '(root)' : issue.path.join('.'),
      message: issue.message,
    }));
    return { diagnostics, errorCount: diagnostics.length, warningCount: 0 };
  }
  const report = checkGeometry(parsed.data, options.geometry ?? {});
  const diagnostics = [
    ...geometryDiagnostics(parsed.data, report),
    ...semanticWarnings(parsed.data),
  ];
  return {
    diagnostics,
    errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
    warningCount: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length,
    geometry: {
      measuredNodes: report.measuredNodes,
      unmeasuredNodes: report.unmeasuredNodes,
      joints: report.joints,
      sampledFrames: report.sampledFrames,
      toleranceScenePx: report.toleranceScenePx,
    },
  };
}

/**
 * Which field a reader should go and edit, per finding.
 *
 * A total record rather than a `switch`, so a sixth check in `@rv/anim-engine` becomes a
 * compile error here instead of a diagnostic that unhelpfully points at the whole node.
 */
const GEOMETRY_PATHS: Readonly<Record<GeometryFinding['code'], string>> = {
  'joint.pivot-outside-parent': 'transform.anchor',
  'joint.opened': 'transform.position',
  'silhouette.area-discontinuity': 'transform',
  'scene.out-of-bounds': 'transform.position',
  'camera.focus-out-of-frame': 'transform.position',
};

/**
 * Geometry findings, turned into diagnostics somebody can act on.
 *
 * Every message names the node rather than its id, quotes the measurement against the
 * tolerance it was judged by, and says which frame to look at - a finding without a
 * reproduction is an opinion.
 */
function geometryDiagnostics(ir: AnimationIR, report: GeometryReport): readonly Diagnostic[] {
  const indexOf = new Map(ir.nodes.map((node, index) => [node.id, index]));
  const nameOf = new Map(ir.nodes.map((node) => [node.id, node.name]));

  // `must` rather than a fallback: every id in a finding came out of this document, so a
  // miss is a broken invariant and not a node whose name we should invent.
  const diagnostics = report.findings.map<Diagnostic>((finding) => {
    const name = must(nameOf, finding.nodeId, 'node name');
    const related =
      finding.relatedNodeId === undefined
        ? name
        : must(nameOf, finding.relatedNodeId, 'related node name');
    return {
      severity: 'error',
      code: finding.code,
      path: `nodes.${String(must(indexOf, finding.nodeId, 'node index'))}.${GEOMETRY_PATHS[finding.code]}`,
      message: geometryMessage(finding, name, related),
    };
  });

  if (report.measuredNodes > 0) return diagnostics;
  return [
    ...diagnostics,
    {
      severity: 'warning',
      code: 'geometry.nothing-measured',
      path: 'nodes',
      message:
        'no node in this document declares a size, so no geometry was checked; give shape ' +
        'nodes a `size` or the silhouette checks cannot see this document at all',
    },
  ];
}

/**
 * One sentence per finding, in the words that say what to change.
 *
 * A lookup rather than a chain of `if`s, for the same reason as {@link GEOMETRY_PATHS}:
 * an unhandled code should not be able to fall through to a generic sentence.
 */
const GEOMETRY_MESSAGES: Readonly<
  Record<GeometryFinding['code'], (name: string, related: string, amount: string) => string>
> = {
  'joint.pivot-outside-parent': (name, related, amount) =>
    `"${name}" overlaps "${related}" at rest but rotates about a pivot ${amount} outside ` +
    'it; a joint stays shut under rotation only while the child pivot lies inside the ' +
    'parent, so this one prises itself open as soon as anything turns it',
  'joint.opened': (name, related, amount) =>
    `"${name}" has come away from "${related}" by ${amount}`,
  'silhouette.area-discontinuity': (name, _related, amount) =>
    `"${name}" changes area discontinuously: ${amount} of the change falls inside one ` +
    'sub-frame interval, which is a pop rather than motion',
  'scene.out-of-bounds': (name, _related, amount) =>
    `"${name}" reaches ${amount} outside the scene box`,
  'camera.focus-out-of-frame': (name, _related, amount) =>
    `"${name}" is the camera focus and sits ${amount} outside the frame`,
};

const GEOMETRY_UNIT_LABELS: Readonly<Record<GeometryFinding['unit'], string>> = {
  'scene-px': 'scene px',
  ratio: '',
};

function geometryMessage(finding: GeometryFinding, name: string, related: string): string {
  const unit = GEOMETRY_UNIT_LABELS[finding.unit];
  const amount = `${finding.measured.toFixed(2)}${unit === '' ? '' : ` ${unit}`}`;
  const sentence = GEOMETRY_MESSAGES[finding.code](name, related, amount);
  return (
    `${sentence} at frame ${String(finding.frame)} (${String(finding.timeMs)} ms); ` +
    `tolerance is ${finding.tolerance.toFixed(2)}${unit === '' ? '' : ` ${unit}`}`
  );
}

/**
 * What a valid document can still get wrong.
 *
 * Every one of these is something the evaluator handles without complaint and a human
 * did not intend: `evaluate` clamps, holds and ignores, so the frame comes out and the
 * motion is not the motion that was authored.
 */
function semanticWarnings(ir: AnimationIR): readonly Diagnostic[] {
  const warnings: Diagnostic[] = [];
  const duration = ir.durationMs;

  const seenNames = new Map<string, number>();
  ir.nodes.forEach((node, index) => {
    const first = seenNames.get(node.name);
    if (first === undefined) {
      seenNames.set(node.name, index);
      return;
    }
    warnings.push({
      severity: 'warning',
      code: 'node.duplicate-name',
      path: `nodes.${String(index)}.name`,
      message:
        `two nodes are called "${node.name}" (also at nodes.${String(first)}); ` +
        'a renderer that resolves a paint table by name will draw one of them twice',
    });
  });

  ir.tracks.forEach((track, index) => {
    track.keyframes.forEach((keyframe, keyIndex) => {
      if (keyframe.timeMs <= duration) return;
      warnings.push({
        severity: 'warning',
        code: 'track.keyframe-past-end',
        path: `tracks.${String(index)}.keyframes.${String(keyIndex)}.timeMs`,
        message:
          `keyframe at ${String(keyframe.timeMs)} ms is past the ${String(duration)} ms ` +
          'timeline and will never be reached',
      });
    });

    const last = track.keyframes[track.keyframes.length - 1];
    if (track.keyframes.length === 1 && last !== undefined && !track.additive) {
      warnings.push({
        severity: 'warning',
        code: 'track.single-keyframe',
        path: `tracks.${String(index)}.keyframes`,
        message:
          'a non-additive track with one keyframe holds a constant; set it on the node ' +
          'transform instead, or add a second keyframe',
      });
    }
  });

  ir.behaviours.forEach((behaviour, index) => {
    if (behaviour.startMs !== undefined && behaviour.startMs >= duration) {
      warnings.push({
        severity: 'warning',
        code: 'behaviour.starts-past-end',
        path: `behaviours.${String(index)}.startMs`,
        message:
          `starts at ${String(behaviour.startMs)} ms, after the ${String(duration)} ms ` +
          'timeline ends; it will never contribute',
      });
    }
    if (behaviour.weight === 0) {
      warnings.push({
        severity: 'warning',
        code: 'behaviour.zero-weight',
        path: `behaviours.${String(index)}.weight`,
        message: 'weight is 0, so this behaviour is authored but silent',
      });
    }
  });

  ir.markers.forEach((marker, index) => {
    if (marker.timeMs <= duration) return;
    warnings.push({
      severity: 'warning',
      code: 'marker.past-end',
      path: `markers.${String(index)}.timeMs`,
      message: `marker "${marker.label}" sits past the end of the timeline`,
    });
  });

  const targeted = new Set<string>([
    ...ir.tracks.map((track) => track.nodeId),
    ...ir.behaviours.map((behaviour) => behaviour.nodeId),
  ]);
  const parents = new Set(ir.nodes.map((node) => node.parentId).filter((id) => id !== null));
  ir.nodes.forEach((node, index) => {
    if (targeted.has(node.id) || parents.has(node.id)) return;
    warnings.push({
      severity: 'warning',
      code: 'node.static-leaf',
      path: `nodes.${String(index)}.id`,
      message:
        `"${node.name}" has no track, no behaviour and no children; it is a static ` +
        'element and costs a draw call per frame',
    });
  });

  return warnings;
}

export const animLintCommand: Command = {
  path: ['anim', 'lint'],
  summary: 'validate an AnimationIR file; exits 3 on a finding',
  usage: [
    'rv anim lint <file.rvanim.json> [--strict] [--json]',
    '  --strict   treat warnings as findings too, so exit 3 covers both',
  ],
  booleans: ['strict'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const path = positional(args, 0);
    if (path === undefined) {
      return usageError(context.io, 'Which file? e.g. rv anim lint scene.rvanim.json', json);
    }

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (caught: unknown) {
      const error = new NotFoundError('animation IR file', path, {
        cause: caught,
      });
      if (json) emitJsonFailure(context.io, error);
      else context.io.err(`  ${error.message}`);
      return EXIT.failed;
    }

    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const report: LintReport = {
        diagnostics: [{ severity: 'error', code: 'json.parse', path: '(file)', message }],
        errorCount: 1,
        warningCount: 0,
      };
      return emit(context, report, path, json, flag(args, 'strict'));
    }

    return emit(context, lintAnimationDocument(document), path, json, flag(args, 'strict'));
  },
};

function emit(
  context: CliContext,
  report: LintReport,
  path: string,
  json: boolean,
  strict: boolean,
): ExitCode {
  const bad = report.errorCount > 0 || (strict && report.warningCount > 0);

  if (json) {
    emitJson(context.io, { file: path, ...report });
    return bad ? EXIT.findings : EXIT.ok;
  }

  context.io.out();
  if (report.diagnostics.length === 0) {
    context.io.out(`  ${path}: clean`);
    // "Clean" without saying what was inspected is the assurance this whole gate exists
    // to stop being given.
    context.io.out(`  ${measuredLine(report)}`);
    context.io.out();
    return EXIT.ok;
  }

  for (const line of table({
    columns: [{ header: 'severity' }, { header: 'code' }, { header: 'path' }, { header: 'detail' }],
    indent: '  ',
    rows: report.diagnostics.map((diagnostic) => [
      diagnostic.severity,
      diagnostic.code,
      diagnostic.path,
      diagnostic.message,
    ]),
  })) {
    context.io.out(line);
  }
  context.io.out();
  context.io.out(
    `  ${String(report.errorCount)} error(s), ${String(report.warningCount)} warning(s) in ${path}`,
  );
  context.io.out(`  ${measuredLine(report)}`);
  context.io.out();
  return bad ? EXIT.findings : EXIT.ok;
}

/** What the geometry pass covered, so "clean" is never an unqualified claim. */
function measuredLine(report: LintReport): string {
  const geometry = report.geometry;
  if (geometry === undefined) return 'geometry not checked: the document did not parse';
  return (
    `geometry: ${String(geometry.measuredNodes)} of ` +
    `${String(geometry.measuredNodes + geometry.unmeasuredNodes)} nodes measured, ` +
    `${String(geometry.joints)} joint(s), ${String(geometry.sampledFrames)} frame(s), ` +
    `tolerance ${geometry.toleranceScenePx.toFixed(2)} scene px`
  );
}
