/**
 * `rv anim lint <file>` - precise diagnostics, non-zero exit.
 *
 * The M3 demo line is `pnpm rv anim lint fixtures/broken.rvanim.json`, and "precise" is
 * the whole requirement: a linter that says "invalid IR" has told you nothing you did
 * not already know from the render failing. Every diagnostic here carries a JSON path
 * you can jump to, a stable code you can grep for, and a sentence that names the thing
 * that is wrong rather than the rule that caught it.
 *
 * Two layers, and the split matters. **Errors** come from `AnimationIR` in
 * `@rv/contracts` - duplicate node ids, unknown parents, hierarchy cycles, tracks and
 * behaviours pointing at nothing, part/bone overrides of a non-instance. Those are the
 * schema's own `superRefine` checks and this file does not restate one of them, because
 * a second implementation of "is this IR valid" is a second implementation to disagree.
 * **Warnings** are the things the schema cannot reasonably reject but a renderer will
 * silently swallow: a keyframe past the end of the timeline, a behaviour window outside
 * it, two nodes with the same name, a marker nobody will ever reach.
 *
 * Exit code 3, not 1: the tool worked perfectly and the file did not. A CI job that
 * retries on 1 must not retry this.
 */

import { readFile } from 'node:fs/promises';

import { AnimationIR } from '@rv/contracts';
import { NotFoundError } from '@rv/shared-kernel';

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
}

/**
 * Lints a parsed JSON document.
 *
 * Separate from the file reading so the whole of the interesting behaviour is a pure
 * function of a value - which is what lets the specs cover every diagnostic without a
 * temporary directory.
 */
export function lintAnimationDocument(document: unknown): LintReport {
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
  const warnings = semanticWarnings(parsed.data);
  return { diagnostics: warnings, errorCount: 0, warningCount: warnings.length };
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
  context.io.out();
  return bad ? EXIT.findings : EXIT.ok;
}
