import { describe, expect, it } from 'vitest';
import { InternalError, createRng, isErr, isOk } from '@rv/shared-kernel';
import { MemoryRetrievalRequest, MemoryRetrievalResult } from '@rv/contracts';

import {
  ARIA,
  KAEL,
  episodeOrdinal,
  valeEntities,
  valeGraph,
  valeRelations,
} from '../__fixtures__/vale';
import {
  SERIES_ID,
  episodeId,
  episodeSummary,
  openLoop,
  relation,
  relationFact,
  sceneId,
  seriesSummary,
  storyTime,
} from '../__fixtures__/builders';
import { KeywordEmbeddingPort } from '../__fixtures__/fakes';
import { NarrativeGraph } from '../graph/narrative-graph';
import { RetrieveSceneContextUseCase } from './retrieve-scene-context';

const EPISODE = episodeId('e05');
const ASOF = '2026-06-01T00:00:00.000Z';

function request(overrides: Record<string, unknown> = {}): MemoryRetrievalRequest {
  return MemoryRetrievalRequest.parse({
    seriesId: SERIES_ID,
    episodeId: EPISODE,
    sceneId: sceneId('e05s01'),
    at: storyTime(episodeOrdinal(5)),
    asOf: ASOF,
    sceneGoal: 'Kael presses Aria about the fire and gets nothing.',
    sceneEntities: [KAEL, ARIA],
    povEntityId: KAEL,
    ...overrides,
  });
}

function graphWithOutline(): NarrativeGraph {
  return valeGraph().with({
    episodeSummaries: [episodeSummary('e05', { index: 4 })],
    seriesSummary: seriesSummary(),
  });
}

function useCase(): RetrieveSceneContextUseCase {
  return new RetrieveSceneContextUseCase({ embeddings: new KeywordEmbeddingPort() });
}

describe('RetrieveSceneContextUseCase — determinism', () => {
  it('produces the identical fact list, ordering included, across repeated calls', async () => {
    const graph = graphWithOutline();
    const first = await useCase().execute({ graph, request: request() });
    const second = await useCase().execute({ graph, request: request() });

    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(first.value).toStrictEqual(second.value);
    expect(first.value.facts.map((fact) => fact.factId)).toEqual(
      second.value.facts.map((fact) => fact.factId),
    );
  });

  it('is unchanged when the input arrays are shuffled', async () => {
    const ordered = graphWithOutline();
    const shuffled = new NarrativeGraph({
      seriesId: SERIES_ID,
      entities: [...valeEntities()].reverse(),
      relations: [...valeRelations()].reverse(),
      facts: [...ordered.facts].reverse(),
      seriesSummary: seriesSummary(),
      episodeSummaries: [episodeSummary('e05', { index: 4 })],
      episodeOrder: ordered.episodeOrder,
    });

    // Same set, different array order: the state hash must not notice, and neither must
    // the retriever.
    expect(shuffled.stateHash).toBe(ordered.stateHash);

    const fromOrdered = await useCase().execute({ graph: ordered, request: request() });
    const fromShuffled = await useCase().execute({ graph: shuffled, request: request() });
    expect(isOk(fromOrdered) && isOk(fromShuffled)).toBe(true);
    if (!isOk(fromOrdered) || !isOk(fromShuffled)) return;
    expect(fromShuffled.value).toStrictEqual(fromOrdered.value);
  });

  it('is unchanged when the scene entity list is reordered', async () => {
    const graph = graphWithOutline();
    const forwards = await useCase().execute({ graph, request: request() });
    const backwards = await useCase().execute({
      graph,
      request: request({ sceneEntities: [ARIA, KAEL] }),
    });
    expect(isOk(forwards) && isOk(backwards)).toBe(true);
    if (!isOk(forwards) || !isOk(backwards)) return;
    expect(backwards.value.facts).toStrictEqual(forwards.value.facts);
  });

  /**
   * Reversal is one permutation, and one permutation is not the property.
   *
   * A comparator that reaches for the *middle* of an array, or a `Map` seeded in insertion
   * order and read back in it, survives `[...items].reverse()` and dies on a shuffle. The
   * claim is "same graph state, same result" for any array order at all, so it is asserted
   * over many seeded permutations of every collection the graph holds - and of the
   * request's own entity list, which the caller controls independently.
   *
   * Seeded rather than random: a flaky determinism test is worse than none, because it
   * teaches people to re-run it.
   */
  function shuffle<T>(items: readonly T[], seed: number): readonly T[] {
    const rng = createRng(seed);
    const out = [...items];
    for (let index = out.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rng.next() * (index + 1));
      const here = out[index];
      const there = out[swap];
      if (here === undefined || there === undefined) continue;
      out[index] = there;
      out[swap] = here;
    }
    return out;
  }

  it('is unchanged under any permutation of any of its input arrays', async () => {
    const ordered = graphWithOutline();
    const summaries = [1, 2, 3, 4, 5].map((index) =>
      episodeSummary(`e0${String(index)}`, { index: index - 1 }),
    );
    const loops = ['loop-a', 'loop-b', 'loop-c'].map((slug) => openLoop(slug));

    const permuted = (seed: number): NarrativeGraph =>
      new NarrativeGraph({
        seriesId: SERIES_ID,
        entities: shuffle(valeEntities(), seed),
        relations: shuffle(valeRelations(), seed + 101),
        facts: shuffle(ordered.facts, seed + 202),
        openLoops: shuffle(loops, seed + 303),
        episodeSummaries: shuffle(summaries, seed + 404),
        seriesSummary: seriesSummary(),
        episodeOrder: ordered.episodeOrder,
      });

    const reference = await useCase().execute({
      graph: permuted(1),
      request: request({ sceneEntities: [KAEL, ARIA] }),
    });
    expect(isOk(reference)).toBe(true);
    if (!isOk(reference)) return;

    const hashes = new Set<string>();
    for (let seed = 1; seed <= 24; seed += 1) {
      const graph = permuted(seed);
      hashes.add(graph.stateHash);
      const result = await useCase().execute({
        graph,
        // The caller's own ordering is an input too, and it alternates here.
        request: request({ sceneEntities: seed % 2 === 0 ? [ARIA, KAEL] : [KAEL, ARIA] }),
      });
      expect(isOk(result), `seed ${String(seed)} failed`).toBe(true);
      if (!isOk(result)) return;
      expect(result.value, `seed ${String(seed)} diverged`).toStrictEqual(reference.value);
    }

    // The same set is the same state: one hash across every permutation, or `stateHash`
    // is a hash of the array and cannot be used to check a replay.
    expect(hashes.size).toBe(1);
  });

  it('shuffles the fixture enough for the previous test to mean something', () => {
    // A shuffle that returned its input would make the assertion above vacuous.
    const entities = valeEntities();
    const distinct = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
        shuffle(entities, seed)
          .map((entity) => entity.id)
          .join('|'),
      ),
    );
    expect(distinct.size).toBeGreaterThan(1);
    expect(distinct.has(entities.map((entity) => entity.id).join('|'))).toBe(false);
  });

  it('breaks ties on a stable key rather than on insertion order', async () => {
    // Every weight zeroed: every candidate scores exactly 0, so ordering is decided
    // entirely by the tie-break.
    //
    // The open loops are load-bearing, not decoration. Facts arrive from `graph.facts`,
    // which `NarrativeGraph` has already sorted by id, so a graph without loops hands the
    // ranker a list that is *already* in the right order and the tie-break is never
    // exercised - the assertion passes with both stable sorts deleted. Open-loop
    // candidates are appended afterwards under **derived** ids that interleave with the
    // fact ids, which is what makes the unsorted order genuinely wrong.
    const graph = graphWithOutline().with({
      openLoops: ['alpha', 'beta', 'gamma', 'delta'].map((slug) => openLoop(slug)),
    });
    const flat = request({
      weights: {
        graphProximity: 0,
        semanticSimilarity: 0,
        storyRecency: 0,
        importance: 0,
        isOpenLoop: 0,
      },
    });

    const result = await useCase().execute({ graph, request: flat });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const scored = result.value.facts.filter((fact) => fact.reason === 'scored');
    expect(scored.length).toBeGreaterThan(1);
    expect(scored.every((fact) => fact.score === 0)).toBe(true);
    // Both kinds are in the tie, or the interleaving above did not happen and the test is
    // back to asserting the graph's own ordering.
    expect(new Set(scored.map((fact) => fact.ref.kind))).toEqual(new Set(['fact', 'open-loop']));
    const ids = scored.map((fact) => fact.factId);
    expect(ids).toEqual([...ids].sort());
  });

  it('ranks by score descending and then by factId, whatever the scores are', async () => {
    // The ordering contract stated in full rather than only at the all-tied extreme, so a
    // tie-break that survives on a flat fixture cannot survive a real one.
    const graph = graphWithOutline().with({
      openLoops: ['alpha', 'beta', 'gamma', 'delta'].map((slug) => openLoop(slug)),
    });
    const result = await useCase().execute({ graph, request: request({ tokenBudget: 100_000 }) });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const scored = result.value.facts.filter((fact) => fact.reason === 'scored');
    expect(scored.length).toBeGreaterThan(1);
    for (let index = 1; index < scored.length; index += 1) {
      const previous = scored[index - 1];
      const current = scored[index];
      if (previous === undefined || current === undefined) continue;
      expect(previous.score, `rank ${String(index)} scores out of order`).toBeGreaterThanOrEqual(
        current.score,
      );
      if (previous.score === current.score) {
        expect(
          previous.factId < current.factId,
          `tied ranks ${String(index - 1)}/${String(index)} are not id-ordered`,
        ).toBe(true);
      }
    }
  });
});

describe('RetrieveSceneContextUseCase — the budget', () => {
  it('never lets scored facts push the total over the budget', async () => {
    const graph = graphWithOutline();
    const unbounded = await useCase().execute({
      graph,
      request: request({ tokenBudget: 100_000 }),
    });
    expect(isOk(unbounded)).toBe(true);
    if (!isOk(unbounded)) return;

    const floor = unbounded.value.facts
      .filter((fact) => fact.reason === 'always')
      .reduce((total, fact) => total + fact.tokens, 0);
    // Room for the floor and a fact or two, and not for all of them.
    const budget = floor + 20;

    const result = await useCase().execute({ graph, request: request({ tokenBudget: budget }) });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.tokensUsed).toBeLessThanOrEqual(budget);
    expect(result.value.facts.reduce((total, fact) => total + fact.tokens, 0)).toBe(
      result.value.tokensUsed,
    );
    expect(result.value.truncated).toBe(true);
    expect(result.value.droppedForBudget.length).toBeGreaterThan(0);
    // Everything dropped is a contiguous suffix of the ranked order, so raising the
    // budget admits them in exactly this order.
    const dropped = result.value.droppedForBudget.map((fact) => fact.rank);
    expect(dropped).toEqual([...dropped].sort((a, b) => a - b));
    expect(result.value.facts.filter((fact) => fact.reason === 'scored').length).toBeLessThan(
      unbounded.value.facts.filter((fact) => fact.reason === 'scored').length,
    );
  });

  it('keeps the unconditional floor even at the tightest budget', async () => {
    const graph = graphWithOutline();
    const result = await useCase().execute({ graph, request: request({ tokenBudget: 1 }) });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const reasons = new Set(result.value.facts.map((fact) => fact.reason));
    expect(reasons).toEqual(new Set(['always']));

    const kinds = result.value.facts.map((fact) => fact.ref.kind);
    expect(kinds).toContain('premise');
    expect(kinds).toContain('episode-summary');
    // Both characters present get a sheet, and the POV character also gets their view.
    expect(kinds.filter((kind) => kind === 'entity').length).toBeGreaterThanOrEqual(3);
    expect(result.value.epistemicView?.viewerId).toBe(KAEL);
    // The floor overran the budget, and the result says so rather than hiding it.
    expect(result.value.truncated).toBe(true);
  });

  it('reports every always-included fact as rank 0, score 1, per the contract', async () => {
    const result = await useCase().execute({
      graph: graphWithOutline(),
      request: request({ tokenBudget: 1 }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    for (const fact of result.value.facts) {
      expect(fact.rank).toBe(0);
      expect(fact.score).toBe(1);
    }
    expect(MemoryRetrievalResult.safeParse(result.value).success).toBe(true);
  });

  it('drops the floor a caller switches off', async () => {
    const result = await useCase().execute({
      graph: graphWithOutline(),
      request: request({
        alwaysInclude: {
          seriesPremise: false,
          episodeOutline: false,
          presentCharacterSheets: false,
          povEpistemicView: false,
        },
      }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.facts.every((fact) => fact.reason === 'scored')).toBe(true);
    // The view is still resolved and returned: it is the POV field, not a budget line.
    expect(result.value.epistemicView).not.toBeNull();
  });

  it('has no epistemic view for a scene with no POV character', async () => {
    const result = await useCase().execute({
      graph: graphWithOutline(),
      request: request({ povEntityId: null }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.epistemicView).toBeNull();
  });
});

describe('RetrieveSceneContextUseCase — what it selects', () => {
  it('retrieves a retro-fitted fact for an early scene', async () => {
    // Asserted while writing episode 7; true in the fiction from episode 2.
    const retrofit = relation({
      slug: 'mentor-was-lying',
      from: ARIA,
      to: KAEL,
      type: 'told',
      fact: 'Aria was already lying to Kael in the second episode.',
      validFrom: storyTime(episodeOrdinal(2)),
      assertedAt: '2026-05-01T00:00:00.000Z',
    });
    const graph = graphWithOutline().with({
      relations: [...valeRelations(), retrofit],
      facts: [
        ...graphWithOutline().facts,
        relationFact('retrofit-fact', retrofit, { importance: 'lead' }),
      ],
    });

    const early = await useCase().execute({
      graph,
      request: request({ at: storyTime(episodeOrdinal(3)), tokenBudget: 100_000 }),
    });
    expect(isOk(early)).toBe(true);
    if (!isOk(early)) return;
    const texts = early.value.facts.map((fact) => fact.text);
    expect(texts).toContain('Aria was already lying to Kael in the second episode.');
  });

  it('hides that same fact from an authoring standpoint before it was written', async () => {
    const retrofit = relation({
      slug: 'mentor-was-lying',
      from: ARIA,
      to: KAEL,
      type: 'told',
      fact: 'Aria was already lying to Kael in the second episode.',
      validFrom: storyTime(episodeOrdinal(2)),
      assertedAt: '2026-05-01T00:00:00.000Z',
    });
    const graph = graphWithOutline().with({
      relations: [...valeRelations(), retrofit],
      facts: [...graphWithOutline().facts, relationFact('retrofit-fact', retrofit)],
    });

    const before = await useCase().execute({
      graph,
      request: request({
        at: storyTime(episodeOrdinal(3)),
        asOf: '2026-04-01T00:00:00.000Z',
        tokenBudget: 100_000,
      }),
    });
    expect(isOk(before)).toBe(true);
    if (!isOk(before)) return;
    expect(before.value.facts.map((fact) => fact.text)).not.toContain(
      'Aria was already lying to Kael in the second episode.',
    );
  });

  it('excludes a fact whose edge has been bounded before the scene', async () => {
    const graph = graphWithOutline();
    const result = await useCase().execute({
      graph,
      request: request({ at: storyTime(episodeOrdinal(9)), tokenBudget: 100_000 }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // The false belief ends at episode 8, so episode 9 must not be handed it as a fact.
    expect(result.value.facts.map((fact) => fact.text)).not.toContain(
      'Kael believes his parents died in the fire.',
    );
  });

  it('respects a visibility filter', async () => {
    const result = await useCase().execute({
      graph: graphWithOutline(),
      request: request({ visibility: ['public'], tokenBudget: 100_000 }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.facts.map((fact) => fact.text)).not.toContain('Aria is Kael’s mother.');
  });

  it('records why each fact is there, with the arithmetic intact', async () => {
    const result = await useCase().execute({
      graph: graphWithOutline(),
      request: request({ tokenBudget: 100_000 }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const scored = result.value.facts.find((fact) => fact.reason === 'scored');
    expect(scored).toBeDefined();
    expect(scored?.breakdown.graphProximity).toBeGreaterThan(0);
    expect(scored?.rank).toBeGreaterThan(0);
    expect(result.value.weights.graphProximity).toBeGreaterThan(0);
    expect(result.value.stateHash).toBe(graphWithOutline().stateHash);
  });

  it('gives an unpaid setup its own candidate and its urgency', async () => {
    const graph = graphWithOutline().with({
      openLoops: [
        {
          id: 'lop_00000000000000000000000001',
          seriesId: SERIES_ID,
          setup: 'A sealed letter is left on the sill.',
          promise: 'The audience expects the letter to be opened.',
          plantedAt: storyTime(episodeOrdinal(1)),
          plantedIn: { episodeId: episodeId('e01') },
          entities: [KAEL],
          relations: [],
          expectedPayoff: { from: storyTime(episodeOrdinal(1)), until: null },
          urgency: 1,
          status: 'open',
          paidIn: null,
        },
      ],
    });

    const result = await useCase().execute({ graph, request: request({ tokenBudget: 100_000 }) });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const loop = result.value.facts.find((fact) => fact.ref.kind === 'open-loop');
    expect(loop).toBeDefined();
    expect(loop?.breakdown.isOpenLoop).toBe(1);
  });
});

describe('RetrieveSceneContextUseCase — the embedder', () => {
  it('asks for one batch, with the scene goal first', async () => {
    const embeddings = new KeywordEmbeddingPort();
    await new RetrieveSceneContextUseCase({ embeddings }).execute({
      graph: graphWithOutline(),
      request: request(),
    });
    expect(embeddings.batches).toHaveLength(1);
    expect(embeddings.batches[0]?.[0]).toContain('Kael presses Aria');
  });

  it('makes no call at all when the semantic weight is zero', async () => {
    const embeddings = new KeywordEmbeddingPort();
    const result = await new RetrieveSceneContextUseCase({ embeddings }).execute({
      graph: graphWithOutline(),
      request: request({
        weights: {
          graphProximity: 0.5,
          semanticSimilarity: 0,
          storyRecency: 0.2,
          importance: 0.2,
          isOpenLoop: 0.1,
        },
      }),
    });
    expect(embeddings.batches).toHaveLength(0);
    expect(isOk(result)).toBe(true);
  });

  it('propagates an embedder failure instead of silently degrading the context', async () => {
    const embeddings = new KeywordEmbeddingPort();
    embeddings.failWith(new InternalError({ message: 'the local model is not loaded' }));
    const result = await new RetrieveSceneContextUseCase({ embeddings }).execute({
      graph: graphWithOutline(),
      request: request(),
    });
    expect(isErr(result)).toBe(true);
  });
});
