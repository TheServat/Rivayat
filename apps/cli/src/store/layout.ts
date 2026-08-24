/**
 * Where the CLI puts things, in one place.
 *
 * docs/04 §7 fixes the shape: `workspace/projects/<projectId>/` per project, and
 * content-addressed binaries shared across all of them. Every path in the CLI comes
 * from a function here rather than a `join` at the call site, so "where did `rv render`
 * write the master" has a single answer and a test can point the whole tool at a
 * temporary directory by changing one field of the context.
 */

import { join } from 'node:path';

import type { ProjectId, RunId } from '@rv/contracts';

export const PROJECTS_DIR = 'projects';

export interface ProjectPaths {
  readonly root: string;
  /** The validated project record. Its existence is what makes the directory a project. */
  readonly project: string;
  /** Settings overrides at project scope - the layer `models set` writes. */
  readonly settings: string;
  /** The locked `StyleBible` the project actually uses, once one is approved. */
  readonly style: string;
  /** Candidate bibles that have been probed but not approved. One file each. */
  readonly stylesDir: string;
  /** Probe sheets, named by style checksum so a re-probe overwrites nothing. */
  readonly probeDir: string;
  /** The `StoryBible` S2 produced. */
  readonly story: string;
  /** Per-character state sets from S3, one file each. */
  readonly castDir: string;
  /** The narrative graph S4 folded, as a `NarrativeGraphInput` document. */
  readonly world: string;
  readonly runsDir: string;
  readonly assetsDir: string;
  readonly renderDir: string;
  readonly deliverDir: string;
}

export function workspaceProjectsDir(workspaceRoot: string): string {
  return join(workspaceRoot, PROJECTS_DIR);
}

export function projectPaths(workspaceRoot: string, projectId: ProjectId): ProjectPaths {
  const root = join(workspaceProjectsDir(workspaceRoot), projectId);
  return {
    root,
    project: join(root, 'project.json'),
    settings: join(root, 'settings.json'),
    style: join(root, 'style.json'),
    stylesDir: join(root, 'styles'),
    probeDir: join(root, 'probes'),
    story: join(root, 'story.json'),
    castDir: join(root, 'cast'),
    world: join(root, 'world.json'),
    runsDir: join(root, 'runs'),
    assetsDir: join(root, 'assets'),
    renderDir: join(root, 'render'),
    deliverDir: join(root, 'deliver'),
  };
}

export interface RunPaths {
  readonly root: string;
  /** The run record: stages, durations, artefacts, spend. */
  readonly run: string;
  /**
   * The cost ledger for this run.
   *
   * A file rather than a row in `usage_records`, because `@rv/persistence` exports no
   * run or usage repository - see the note in `commands/cost.ts`.
   */
  readonly ledger: string;
  /** Render checkpoints, so a killed render resumes rather than restarts. */
  readonly checkpoints: string;
  readonly framesDir: string;
}

export function runPaths(paths: ProjectPaths, runId: RunId): RunPaths {
  const root = join(paths.runsDir, runId);
  return {
    root,
    run: join(root, 'run.json'),
    ledger: join(root, 'ledger.json'),
    checkpoints: join(root, 'checkpoints'),
    framesDir: join(root, 'frames'),
  };
}

/** The asset demand plan for one episode, written by `assets plan` and read by `run`. */
export function assetPlanPath(paths: ProjectPaths, episodeId: string): string {
  return join(paths.assetsDir, `plan-${sanitise(episodeId)}.json`);
}

/** The animation IR for one episode. Produced by S8, consumed by `render`. */
export function animationPath(paths: ProjectPaths, episodeId: string): string {
  return join(paths.renderDir, `${sanitise(episodeId)}.rvanim.json`);
}

/** The encoded master for one episode. What `deliver` cuts every format from. */
export function masterPath(paths: ProjectPaths, episodeId: string): string {
  return join(paths.renderDir, `${sanitise(episodeId)}-master.mp4`);
}

/**
 * Makes an identifier safe to use as a path segment.
 *
 * Episode ids are prefixed ULIDs and safe already, but the CLI accepts the human
 * spelling too (`E01`), and a user typing `--episode ../../etc` must not escape the
 * workspace.
 */
export function sanitise(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
