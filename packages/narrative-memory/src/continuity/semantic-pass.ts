/**
 * The semantic pass: judgement, and only where judgement is needed.
 *
 * Tone drift, a motivation that reverses without a beat to justify it, an arc that walks
 * backwards - none of these is an interval overlap, and no rule will ever catch them.
 * They are also expensive to ask about, which is why this runs second and is shown only
 * what the rule pass could not decide. A scene the rules already flagged is withheld: it
 * is going back for a rewrite regardless, and paying a model to have a second opinion
 * about it buys nothing.
 *
 * The model is not asked for ids. It names characters and quotes the two statements that
 * clash; we resolve the names against the graph and materialise the quotes as `statement`
 * facts, exactly as the rule pass does, so a semantic finding is as clickable as a
 * structural one.
 */

import { type Clock, type Result, err, isErr, ok, toIso } from '@rv/shared-kernel';
import type { StructuredBackend, StructuredTrace } from '@rv/prompt-kit';
import { StructuredCall } from '@rv/prompt-kit';
import { z } from 'zod';
import {
  Confidence,
  ContinuitySeverity,
  Label,
  Prose,
  type ContinuityIssue,
  type ContinuityRule,
  type EntityId,
  type EpisodeId,
  type Fact,
  type FactId,
} from '@rv/contracts';

import { deriveIssueId, seed } from '../graph/derive-id';
import { MentionResolver } from '../extract/coreference';
import { compareStrings, type NarrativeGraph } from '../graph/narrative-graph';
import { FactCitations } from './citations';
import type { SceneUnderCheck } from './rules';

/** The four rules that need the series bible read as prose rather than queried. */
export const SEMANTIC_RULES = [
  'tone-drift',
  'motivation-contradiction',
  'arc-regression',
  'world-rule-broken',
] as const;

export const SemanticFinding = z.strictObject({
  rule: z.enum(SEMANTIC_RULES),
  severity: ContinuitySeverity.describe(
    'Use "error" only when the episode must not air as written. Tone and arc notes are warnings.',
  ),
  characters: z
    .array(Label)
    .max(32)
    .default([])
    .describe('Who is involved, by the name the series uses. Never invent an identifier.'),
  conflicting: z
    .array(Prose)
    .min(2)
    .max(8)
    .describe(
      'The statements that cannot all stand, quoted or paraphrased. At least two - a finding that names only one side is not actionable.',
    ),
  explanation: Prose.describe('What is wrong, in one paragraph, naming both sides.'),
  suggestedFix: Prose.optional().describe('The smallest edit that resolves it.'),
  confidence: Confidence.default(0.6),
});
export type SemanticFinding = z.infer<typeof SemanticFinding>;

export const SemanticContinuityFindings = z.strictObject({
  findings: z
    .array(SemanticFinding)
    .max(32)
    .default([])
    .describe('Empty is a valid and common answer. Do not invent a finding to be useful.'),
});
export type SemanticContinuityFindings = z.infer<typeof SemanticContinuityFindings>;

export const SEMANTIC_SYSTEM_PROMPT = [
  'You are a continuity editor for an animated series. Structural checks have already',
  'run and their findings are not your job: ignore timelines, locations, who is alive,',
  'who knows what, wardrobe and props entirely.',
  '',
  'Judge only these four things:',
  '- tone-drift: the episode does not feel like the series described in the tone note.',
  '- motivation-contradiction: a character does something their want, need, wound or lie',
  '  does not support, and the episode does not earn the change.',
  '- arc-regression: a character undoes progress the series already paid for.',
  '- world-rule-broken: something happens that a stated rule of the world forbids.',
  '',
  'Report nothing rather than something. An empty findings list is the correct answer',
  'for a clean episode, and a speculative finding costs a writer an hour.',
].join('\n');

export interface SemanticContinuityInput {
  readonly graph: NarrativeGraph;
  readonly episodeId: EpisodeId;
  /** Everything the rule pass looked at. Flagged scenes are filtered out here. */
  readonly scenes: readonly SceneUnderCheck[];
  /** Findings from the rule pass, used only to decide what to withhold. */
  readonly decided: readonly ContinuityIssue[];
}

export interface SemanticContinuityOutput {
  readonly issues: readonly ContinuityIssue[];
  readonly citedFacts: readonly Fact[];
  readonly trace: StructuredTrace;
  /** Scenes actually sent. Empty means the pass short-circuited and made no call. */
  readonly reviewed: readonly SceneUnderCheck[];
}

export interface SemanticContinuityDeps {
  readonly backends: readonly StructuredBackend[];
  readonly clock: Clock;
  readonly structuredCall?: StructuredCall;
}

export class RunSemanticContinuityPassUseCase {
  readonly #call: StructuredCall;
  readonly #backends: readonly StructuredBackend[];
  readonly #clock: Clock;

  constructor(deps: SemanticContinuityDeps) {
    this.#backends = deps.backends;
    this.#clock = deps.clock;
    this.#call = deps.structuredCall ?? new StructuredCall({ clock: deps.clock });
  }

  async execute(input: SemanticContinuityInput): Promise<Result<SemanticContinuityOutput>> {
    const decidedScenes = new Set(
      input.decided.map((issue) => issue.sceneId).filter((sceneId) => sceneId !== undefined),
    );
    const reviewed = input.scenes.filter(
      (scene) => !decidedScenes.has(scene.sceneId) && scene.synopsis !== undefined,
    );

    if (reviewed.length === 0) {
      return ok({ issues: [], citedFacts: [], trace: EMPTY_TRACE, reviewed: [] });
    }

    const called = await this.#call.run({
      schemaName: 'SemanticContinuityFindings',
      schema: SemanticContinuityFindings,
      backends: this.#backends,
      system: SEMANTIC_SYSTEM_PROMPT,
      user: this.#buildPrompt(input, reviewed),
    });
    if (isErr(called)) return err(called.error.error);

    return ok({
      ...this.#materialise(input, called.value.value),
      trace: called.value.trace,
      reviewed,
    });
  }

  #buildPrompt(input: SemanticContinuityInput, reviewed: readonly SceneUnderCheck[]): string {
    const { graph } = input;
    const parts: string[] = [];
    if (graph.seriesSummary !== null) {
      parts.push(
        [
          `Series premise: ${graph.seriesSummary.premise}`,
          `Tone baseline: ${graph.seriesSummary.toneNote}`,
          ...graph.seriesSummary.rulesOfTheWorld.map((rule) => `Rule of the world: ${rule}`),
        ].join('\n'),
      );
    }

    const sheets = graph.entities
      .filter((entity) => entity.kind === 'character')
      .filter((entity) => entity.importance === 'lead' || entity.importance === 'supporting')
      .map(
        (entity) =>
          `- ${entity.canonicalName}: wants ${entity.payload.psych.want}; believes the lie "${entity.payload.psych.lie}"; arc runs ${entity.payload.arc.startState} -> ${entity.payload.arc.endState}.`,
      );
    if (sheets.length > 0) parts.push(['Principal cast:', ...sheets].join('\n'));

    parts.push(
      [
        'Scenes still undecided (the structural pass has already settled the rest, and they',
        'are deliberately not shown to you):',
        ...reviewed.map(
          (scene) => `- [${scene.sceneId} @ ${String(scene.at.ordinal)}] ${scene.synopsis ?? ''}`,
        ),
      ].join('\n'),
    );

    return parts.join('\n\n');
  }

  #materialise(
    input: SemanticContinuityInput,
    produced: SemanticContinuityFindings,
  ): { issues: readonly ContinuityIssue[]; citedFacts: readonly Fact[] } {
    const { graph, episodeId } = input;
    const cite = new FactCitations(graph.seriesId, toIso(this.#clock.now()), graph.facts);
    const resolver = new MentionResolver(graph.entities);
    const issues: ContinuityIssue[] = [];

    for (const finding of produced.findings) {
      const conflictingFacts: FactId[] = finding.conflicting.map((statement) =>
        cite.statement(statement, null, { kind: 'inferred', rule: `llm:${finding.rule}` }),
      );
      // Two identical quotes collapse to one derived id and would trip the schema's
      // "name both sides" refinement, so a finding that quoted itself twice is dropped
      // rather than emitted invalid.
      const unique = [...new Set(conflictingFacts)];
      if (unique.length < 2) continue;

      const entities: EntityId[] = [];
      for (const name of finding.characters) {
        const resolved = resolver.resolve(name);
        if (resolved.ok) entities.push(resolved.entityId);
      }

      issues.push({
        id: deriveIssueId(seed(graph.seriesId, episodeId, finding.rule, ...unique)),
        seriesId: graph.seriesId,
        episodeId,
        severity: finding.severity,
        rule: finding.rule satisfies ContinuityRule,
        detectedBy: 'llm',
        entities: [...new Set(entities)].sort(compareStrings),
        conflictingFacts: unique,
        explanation: finding.explanation,
        ...(finding.suggestedFix !== undefined ? { suggestedFix: finding.suggestedFix } : {}),
        confidence: finding.confidence,
      });
    }

    return {
      issues: issues.sort((a, b) => compareStrings(a.id, b.id)),
      citedFacts: cite.facts,
    };
  }
}

/** What a pass that never called anything reports. Zeroed rather than absent, so the ledger still gets a row. */
const EMPTY_TRACE: StructuredTrace = Object.freeze({
  schemaName: 'SemanticContinuityFindings',
  resolution: 'clean',
  modelId: 'none',
  attempts: 0,
  repairTurns: 0,
  fenceStripped: false,
  usedNativeSchemaEnforcement: false,
  escalatedTo: null,
  failedPaths: [],
  errorCode: null,
  totalLatencyMs: 0,
  costNanoUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
  extractionSteps: [],
});
