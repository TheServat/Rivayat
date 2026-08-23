import { describe, expect, it } from 'vitest';
import { FixedClock, fromIso, instant, isErr, isOk } from '@rv/shared-kernel';
import { ContinuityIssue } from '@rv/contracts';

import {
  ARIA,
  KAEL,
  SWORD,
  VALE,
  episodeOrdinal,
  parentageEdge,
  valeGraph,
} from '../__fixtures__/vale';
import { episodeId, sceneId, storyTime } from '../__fixtures__/builders';
import { FakeStructuredBackend, ForbiddenStructuredBackend } from '../__fixtures__/fakes';
import { CheckEpisodeContinuityUseCase } from './check-episode-continuity';
import { RunSemanticContinuityPassUseCase } from './semantic-pass';
import { runContinuityRules, type SceneUnderCheck } from './rules';

const CLOCK = new FixedClock(instant(Date.parse('2026-08-01T00:00:00.000Z')));
const ASOF = fromIso('2026-08-01T00:00:00.000Z');
const EPISODE = episodeId('e05');

const CLEAN_SCENE: SceneUnderCheck = {
  sceneId: sceneId('clean'),
  at: storyTime(episodeOrdinal(5)),
  locationId: VALE,
  synopsis: 'Aria refuses to answer and Kael lets it go, which he never does.',
};

function messyScene(graph: ReturnType<typeof valeGraph>): SceneUnderCheck {
  return {
    sceneId: sceneId('messy'),
    at: storyTime(episodeOrdinal(5)),
    locationId: VALE,
    usesKnowledge: [{ knowerId: KAEL, relationId: parentageEdge(graph).id }],
    synopsis: 'Kael names his mother out loud, three episodes early.',
  };
}

const FINDINGS = {
  findings: [
    {
      rule: 'motivation-contradiction',
      severity: 'warning',
      characters: ['Kael'],
      conflicting: [
        'Kael lets the question go.',
        'Kael has never let a question about the fire go.',
      ],
      explanation: 'Kael abandons the pursuit without the episode paying for the change.',
      suggestedFix: 'Give him a reason to stop, or let him press.',
      confidence: 0.7,
    },
  ],
};

describe('RunSemanticContinuityPassUseCase', () => {
  it('is shown only the scenes the rule pass could not decide', async () => {
    const graph = valeGraph();
    const messy = messyScene(graph);
    const decided = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [messy, CLEAN_SCENE],
    }).issues;

    const backend = new FakeStructuredBackend([FINDINGS]);
    const result = await new RunSemanticContinuityPassUseCase({
      backends: [backend],
      clock: CLOCK,
    }).execute({ graph, episodeId: EPISODE, scenes: [messy, CLEAN_SCENE], decided });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.reviewed.map((scene) => scene.sceneId)).toEqual([CLEAN_SCENE.sceneId]);
    expect(backend.lastPrompt).toContain('Aria refuses to answer');
    expect(backend.lastPrompt).not.toContain('three episodes early');
  });

  it('gives the model the tone baseline and the leads it must judge against', async () => {
    const backend = new FakeStructuredBackend([FINDINGS]);
    await new RunSemanticContinuityPassUseCase({ backends: [backend], clock: CLOCK }).execute({
      graph: valeGraph(),
      episodeId: EPISODE,
      scenes: [CLEAN_SCENE],
      decided: [],
    });
    expect(backend.lastPrompt).toContain('Tone baseline:');
    expect(backend.lastPrompt).toContain('Rule of the world: The dead do not come back.');
    expect(backend.lastPrompt).toContain('arc runs');
  });

  it('resolves names to ids and materialises the quoted statements as facts', async () => {
    const backend = new FakeStructuredBackend([FINDINGS]);
    const result = await new RunSemanticContinuityPassUseCase({
      backends: [backend],
      clock: CLOCK,
    }).execute({ graph: valeGraph(), episodeId: EPISODE, scenes: [CLEAN_SCENE], decided: [] });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [issue] = result.value.issues;
    expect(issue?.detectedBy).toBe('llm');
    expect(issue?.entities).toEqual([KAEL]);
    expect(issue?.conflictingFacts).toHaveLength(2);
    expect(result.value.citedFacts).toHaveLength(2);
    expect(ContinuityIssue.safeParse(issue).success).toBe(true);
  });

  it('drops a finding that quoted the same statement twice rather than emitting an invalid one', async () => {
    const backend = new FakeStructuredBackend([
      {
        findings: [
          {
            rule: 'tone-drift',
            severity: 'warning',
            characters: [],
            conflicting: ['The same sentence.', 'The same sentence.'],
            explanation: 'It only named one side.',
          },
        ],
      },
    ]);
    const result = await new RunSemanticContinuityPassUseCase({
      backends: [backend],
      clock: CLOCK,
    }).execute({ graph: valeGraph(), episodeId: EPISODE, scenes: [CLEAN_SCENE], decided: [] });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.issues).toEqual([]);
  });

  it('ignores a character the model named who is not in the graph', async () => {
    const backend = new FakeStructuredBackend([
      { findings: [{ ...FINDINGS.findings[0], characters: ['Nobody At All'] }] },
    ]);
    const result = await new RunSemanticContinuityPassUseCase({
      backends: [backend],
      clock: CLOCK,
    }).execute({ graph: valeGraph(), episodeId: EPISODE, scenes: [CLEAN_SCENE], decided: [] });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.issues[0]?.entities).toEqual([]);
  });

  it('spends nothing when the rules already decided everything', async () => {
    const graph = valeGraph();
    const messy = messyScene(graph);
    const decided = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [messy],
    }).issues;

    const backend = new FakeStructuredBackend([FINDINGS]);
    const result = await new RunSemanticContinuityPassUseCase({
      backends: [backend],
      clock: CLOCK,
    }).execute({ graph, episodeId: EPISODE, scenes: [messy], decided });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(backend.callCount).toBe(0);
    expect(result.value.trace.attempts).toBe(0);
    expect(result.value.issues).toEqual([]);
  });

  it('propagates a backend failure', async () => {
    const result = await new RunSemanticContinuityPassUseCase({
      backends: [new FakeStructuredBackend()],
      clock: CLOCK,
    }).execute({ graph: valeGraph(), episodeId: EPISODE, scenes: [CLEAN_SCENE], decided: [] });
    expect(isErr(result)).toBe(true);
  });

  it('works on a series with no summary yet', async () => {
    const backend = new FakeStructuredBackend([FINDINGS]);
    const result = await new RunSemanticContinuityPassUseCase({
      backends: [backend],
      clock: CLOCK,
    }).execute({
      graph: valeGraph().with({ seriesSummary: null }),
      episodeId: EPISODE,
      scenes: [CLEAN_SCENE],
      decided: [],
    });
    expect(isOk(result)).toBe(true);
    expect(backend.lastPrompt).not.toContain('Tone baseline:');
  });
});

describe('CheckEpisodeContinuityUseCase', () => {
  it('runs the free pass and no provider unless asked', async () => {
    const graph = valeGraph();
    const result = await new CheckEpisodeContinuityUseCase({
      backends: [new ForbiddenStructuredBackend()],
      clock: CLOCK,
    }).execute({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [messyScene(graph), CLEAN_SCENE],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.blocked).toBe(true);
    expect(result.value.errors.map((issue) => issue.rule)).toEqual(['knowledge-without-source']);
    expect(result.value.semanticTrace).toBeNull();
  });

  it('adds the semantic findings when asked, on top of the rule ones', async () => {
    const graph = valeGraph();
    const backend = new FakeStructuredBackend([FINDINGS]);
    const result = await new CheckEpisodeContinuityUseCase({
      backends: [backend],
      clock: CLOCK,
    }).execute({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [messyScene(graph), CLEAN_SCENE],
      semantic: true,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(new Set(result.value.issues.map((issue) => issue.rule))).toEqual(
      new Set(['knowledge-without-source', 'motivation-contradiction']),
    );
    expect(result.value.warnings.map((issue) => issue.rule)).toEqual(['motivation-contradiction']);
    expect(result.value.semanticTrace).not.toBeNull();
  });

  it('folds the open-loop report into the same findings list', async () => {
    const graph = valeGraph().with({
      openLoops: [
        {
          id: 'lop_00000000000000000000000002',
          seriesId: valeGraph().seriesId,
          setup: 'A sealed letter.',
          promise: 'The audience expects it opened.',
          plantedAt: storyTime(episodeOrdinal(1)),
          plantedIn: { episodeId: episodeId('e01') },
          entities: [KAEL, SWORD],
          relations: [],
          expectedPayoff: { from: storyTime(episodeOrdinal(1)), until: null },
          urgency: 1,
          status: 'open',
          paidIn: null,
        },
      ],
    });

    const result = await new CheckEpisodeContinuityUseCase({ clock: CLOCK }).execute({
      graph,
      episodeId: episodeId('e09'),
      asOf: ASOF,
      scenes: [],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.warnings.map((issue) => issue.rule)).toEqual(['unpaid-open-loop']);
    expect(result.value.blocked).toBe(false);
  });

  it('propagates a semantic failure rather than reporting a clean episode', async () => {
    const result = await new CheckEpisodeContinuityUseCase({
      backends: [new FakeStructuredBackend()],
      clock: CLOCK,
    }).execute({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [CLEAN_SCENE],
      semantic: true,
    });
    expect(isErr(result)).toBe(true);
  });

  it('deduplicates a fact both passes cited', async () => {
    const graph = valeGraph();
    const result = await new CheckEpisodeContinuityUseCase({
      backends: [new FakeStructuredBackend([FINDINGS])],
      clock: CLOCK,
    }).execute({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [messyScene(graph), CLEAN_SCENE],
      semantic: true,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const ids = result.value.citedFacts.map((fact) => fact.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('skips the semantic pass when no backend was wired at all', async () => {
    const result = await new CheckEpisodeContinuityUseCase({ clock: CLOCK }).execute({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [CLEAN_SCENE],
      semantic: true,
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.semanticTrace).toBeNull();
  });

  it('accepts an injected semantic pass', async () => {
    const backend = new FakeStructuredBackend([FINDINGS]);
    const result = await new CheckEpisodeContinuityUseCase({
      clock: CLOCK,
      semanticPass: new RunSemanticContinuityPassUseCase({ backends: [backend], clock: CLOCK }),
    }).execute({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [CLEAN_SCENE],
      semantic: true,
    });
    expect(isOk(result)).toBe(true);
    expect(backend.callCount).toBe(1);
  });
});

describe('the gate, end to end', () => {
  it('an error found by the check blocks airing; the same episode without it does not', async () => {
    const graph = valeGraph();
    const { AirEpisodeUseCase } = await import('./air-episode');
    const air = new AirEpisodeUseCase({ clock: CLOCK });

    const blocked = await new CheckEpisodeContinuityUseCase({ clock: CLOCK }).execute({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [messyScene(graph)],
    });
    expect(isOk(blocked)).toBe(true);
    if (!isOk(blocked)) return;
    expect(
      isErr(air.execute({ episodeId: EPISODE, status: 'rendered', issues: blocked.value.issues })),
    ).toBe(true);

    const clean = await new CheckEpisodeContinuityUseCase({ clock: CLOCK }).execute({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        {
          sceneId: sceneId('fine'),
          at: storyTime(episodeOrdinal(5)),
          locationId: VALE,
          actingEntityIds: [ARIA],
        },
      ],
    });
    expect(isOk(clean)).toBe(true);
    if (!isOk(clean)) return;
    expect(
      isOk(air.execute({ episodeId: EPISODE, status: 'rendered', issues: clean.value.issues })),
    ).toBe(true);
  });
});
