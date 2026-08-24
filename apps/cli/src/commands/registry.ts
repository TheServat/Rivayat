/**
 * Every command `rv` has, in one table.
 *
 * The table is the contract. `rv help` renders it, the dispatcher walks it, and
 * `registry.spec.ts` asserts that every command named in a milestone demo block in
 * `docs/03-backlog.md` has an entry - which is the only way "the CLI covers the demos"
 * can be a test rather than a claim.
 */

import type { Command } from '../cli/command';
import { animLintCommand } from './anim-lint';
import { assetsBakeCommand, assetsEditCommand, assetsPlanCommand } from './assets';
import { animateCommand, assetsProduceCommand, characterCommand, doctorCommand } from './basics';
import { castStatesCommand } from './cast';
import { costReportCommand, seriesCostCommand } from './cost';
import { continuityCheckCommand, graphShowCommand } from './graph';
import { modelsListCommand, modelsSetCommand } from './models';
import { projectListCommand, projectNewCommand } from './project';
import { deliverCommand, renderCommand, renderResumeCommand } from './render';
import { createRunCommand } from './run';
import { storyNewCommand } from './story';
import { styleListCommand, styleLockCommand, styleProbeCommand } from './style';

/**
 * Everything except `run`.
 *
 * Separated because `run` sequences the others: handing it this list rather than the
 * whole table is what keeps it from being able to invoke itself.
 */
export const STAGE_COMMANDS: readonly Command[] = [
  doctorCommand,
  characterCommand,
  animateCommand,
  projectNewCommand,
  projectListCommand,
  modelsListCommand,
  modelsSetCommand,
  styleListCommand,
  styleProbeCommand,
  styleLockCommand,
  costReportCommand,
  seriesCostCommand,
  storyNewCommand,
  castStatesCommand,
  graphShowCommand,
  continuityCheckCommand,
  assetsPlanCommand,
  assetsProduceCommand,
  assetsBakeCommand,
  assetsEditCommand,
  animLintCommand,
  renderCommand,
  renderResumeCommand,
  deliverCommand,
];

export const COMMANDS: readonly Command[] = [
  ...STAGE_COMMANDS,
  createRunCommand(() => STAGE_COMMANDS),
];
