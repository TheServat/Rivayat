/**
 * Both passes, in the order that makes the second one cheap.
 *
 * Rules first because they are free and exact; the model second, and only on what the
 * rules could not decide. Running them the other way round costs money to be told what a
 * set comparison already knew, and running only the model means a dead character speaking
 * is caught probabilistically.
 *
 * The result is the gate: `blocked` is true when any finding is an `error`, and that is
 * the single fact `AirEpisodeUseCase` consults.
 */

import { type Instant, type Result, isErr, ok } from '@rv/shared-kernel';
import type { StructuredBackend, StructuredTrace } from '@rv/prompt-kit';
import { blocksAiring, type ContinuityIssue, type EpisodeId, type Fact } from '@rv/contracts';

import { compareStrings, type NarrativeGraph } from '../graph/narrative-graph';
import { runContinuityRules, type ContinuityRuleOptions, type SceneUnderCheck } from './rules';
import { RunSemanticContinuityPassUseCase, type SemanticContinuityDeps } from './semantic-pass';
import { reportOpenLoops, type OpenLoopReportOptions } from '../loops/track-open-loops';

export interface CheckEpisodeContinuityInput extends ContinuityRuleOptions, OpenLoopReportOptions {
  readonly graph: NarrativeGraph;
  readonly episodeId: EpisodeId;
  readonly scenes: readonly SceneUnderCheck[];
  readonly asOf: Instant;
  /**
   * Whether to spend money on the semantic half.
   *
   * Off by default. A pipeline running the check on every save wants the free pass; the
   * one gating an air date wants both.
   */
  readonly semantic?: boolean;
}

export interface ContinuityReport {
  readonly issues: readonly ContinuityIssue[];
  readonly citedFacts: readonly Fact[];
  /** True when at least one finding is an `error`. The whole airing contract. */
  readonly blocked: boolean;
  readonly errors: readonly ContinuityIssue[];
  readonly warnings: readonly ContinuityIssue[];
  /** `null` when the semantic pass was not run. */
  readonly semanticTrace: StructuredTrace | null;
}

export interface CheckEpisodeContinuityDeps {
  readonly backends?: readonly StructuredBackend[];
  readonly semanticPass?: RunSemanticContinuityPassUseCase;
  readonly clock: SemanticContinuityDeps['clock'];
}

export class CheckEpisodeContinuityUseCase {
  readonly #semanticPass: RunSemanticContinuityPassUseCase | undefined;

  constructor(deps: CheckEpisodeContinuityDeps) {
    this.#semanticPass =
      deps.semanticPass ??
      (deps.backends === undefined
        ? undefined
        : new RunSemanticContinuityPassUseCase({ backends: deps.backends, clock: deps.clock }));
  }

  async execute(input: CheckEpisodeContinuityInput): Promise<Result<ContinuityReport>> {
    const ruleReport = runContinuityRules(input);
    const loopReport = reportOpenLoops(input.graph, {
      ...input,
      episodeId: input.episodeId,
    });

    let issues = [...ruleReport.issues, ...loopReport.issues];
    let citedFacts = [...ruleReport.citedFacts];
    let semanticTrace: StructuredTrace | null = null;

    if (input.semantic === true && this.#semanticPass !== undefined) {
      const semantic = await this.#semanticPass.execute({
        graph: input.graph,
        episodeId: input.episodeId,
        scenes: input.scenes,
        decided: issues,
      });
      if (isErr(semantic)) return semantic;
      issues = [...issues, ...semantic.value.issues];
      citedFacts = [...citedFacts, ...semantic.value.citedFacts];
      semanticTrace = semantic.value.trace;
    }

    const ordered = issues.sort((a, b) => compareStrings(a.id, b.id));
    const errors = ordered.filter(blocksAiring);

    return ok({
      issues: ordered,
      citedFacts: dedupeFacts(citedFacts),
      blocked: errors.length > 0,
      errors,
      warnings: ordered.filter((issue) => !blocksAiring(issue)),
      semanticTrace,
    });
  }
}

/** Both passes materialise citations, and both may cite the same edge. */
function dedupeFacts(facts: readonly Fact[]): readonly Fact[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  return [...byId.values()].sort((a, b) => compareStrings(a.id, b.id));
}
