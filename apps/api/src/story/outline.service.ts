/**
 * One level of the story tree, grown, edited or regrown - and never more than one.
 *
 * `ExpandOutlineLevelUseCase` in `@rv/story-engine` already owns the DOC discipline: it
 * refuses a target level that is not exactly one below its parent, and it refuses an
 * expansion that does not quote its parent's instruction back word for word. This
 * service is the joint between that use-case and the HTTP surface, and it exists to
 * make sure the joint cannot widen the contract.
 *
 * **There is no `expandTo(level)` and no `buildTree()`, deliberately.** The studio
 * implements "build the rest" as a *loop* over "build one more" for exactly this
 * reason, and an endpoint that descended three levels in one request would put the
 * bypass in the transport where the engine's guard cannot see it. The failure that
 * prevents is concrete and reproducible: ask a model for "the scenes of this series"
 * and it writes twelve good scenes for episode one and forgets the antagonist by
 * episode seven, because nothing in between ever said what episode seven was *for*.
 *
 * Three properties beyond that:
 *
 * - **An expansion is one call per parent, not one call per level.** Episode 4's acts
 *   are bound to what episode 4 was asked to be; a single call covering six episodes
 *   would produce acts bound to nothing. The parents are walked in ordinal order so a
 *   replay produces the same tree.
 * - **An edit never deletes silently.** `keep` marks the descendants `stale`;
 *   `re-expand` drops them. Both are the caller's explicit choice, made while looking at
 *   how many children there are.
 * - **Nothing here reads a wall clock.** Every `createdAt` comes from the injected
 *   `Clock`, and every id from the injected `Ids`.
 */

import { Ids, type CanonPolicy, type SeriesId } from '@rv/contracts';
import type { StructuredTrace } from '@rv/prompt-kit';
import {
  ExpandOutlineLevelUseCase,
  type OutlineChildDraft,
  type OutlineContext,
  type StoryEngineDeps,
} from '@rv/story-engine';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  err,
  isErr,
  ok,
  toIso,
  type AppError,
  type Clock,
  type Result,
} from '@rv/shared-kernel';

import {
  StoryExpansion,
  StoryNode,
  childLevelOf,
  descendantIdsOf,
  parentLevelOf,
  type OutlineLevel,
  type StoryNodeEdit,
} from './story.contracts';
import {
  emptyStoryDocument,
  type StoredOutlineContext,
  type StoryDocument,
  type StoryStore,
} from './story.store';

/**
 * The canon policy a series gets before anyone has chosen one.
 *
 * The strictest of the three, because the loosest is the one that cannot be tightened
 * later without invalidating everything written under it: an outline produced under
 * "retcons allowed" and then re-read under "reveal-only" is a set of contradictions.
 */
export const DEFAULT_CANON_POLICY: CanonPolicy = {
  freezeOnAir: true,
  retcon: 'reveal-only',
  strictness: 'strict',
};

export interface OutlineServiceDeps {
  readonly store: StoryStore;
  readonly clock: Clock;
  readonly ids: Ids;
}

/** What one expansion needs beyond the level, all of it optional. */
export interface ExpandLevelOptions {
  readonly childCount?: { readonly min: number; readonly max: number };
  readonly directive?: string;
  readonly signal?: AbortSignal;
}

/**
 * An expansion, with the traces the calls produced.
 *
 * The traces are carried out rather than swallowed because the *stage* is the metered
 * unit: `StoryExpansion.spentNanoUsd` is the number a UI renders, and the ledger needs
 * the token counts behind it. A service that reported only the money would leave S2's
 * usage row reading as one intake call.
 */
export interface OutlineChange {
  readonly expansion: StoryExpansion;
  readonly traces: readonly StructuredTrace[];
}

/**
 * What planting the root needs.
 *
 * A title and a premise rather than a `SeriesCard`, because the two callers hold
 * different things: the HTTP route has the card the author typed, and S2 has the
 * *normalised* brief S0 produced from it. Taking the card would force the stage to
 * write its premise back before it could plant the root it just derived.
 */
export interface PlantRootInput {
  readonly seriesId: SeriesId;
  readonly title: string;
  readonly premise: string;
  readonly context?: OutlineContext;
  readonly styleBibleId?: string;
}

/**
 * Which minter names a node at each level.
 *
 * A table rather than a `switch` (CLAUDE.md §2), and total over the union so adding a
 * level to `OUTLINE_LEVELS` is a compile error here rather than an `undefined` id at
 * runtime. The series root is the exception: it is addressed by the `SeriesId` it
 * already has, because minting a second identity for the series would give the tree a
 * root nothing else in the system can name.
 */
type NodeMinter = (ids: Ids, seriesId: SeriesId) => string;

const MINT_NODE_ID: Readonly<Record<OutlineLevel, NodeMinter>> = {
  series: (_ids, seriesId) => seriesId,
  season: (ids) => ids.season(),
  episode: (ids) => ids.episode(),
  act: (ids) => ids.act(),
  sequence: (ids) => ids.sequence(),
  scene: (ids) => ids.scene(),
  beat: (ids) => ids.beat(),
};

export class OutlineService {
  readonly #store: StoryStore;
  readonly #clock: Clock;
  readonly #ids: Ids;

  constructor(deps: OutlineServiceDeps) {
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
  }

  /**
   * Plants the root, from the author's own premise, without calling a model.
   *
   * The series node is not an expansion of anything: its parent is the brief. Asking a
   * model to restate a premise the author just typed is asking it to paraphrase canon,
   * so this is free, instant, and marked `author` in its provenance.
   */
  async plantRoot(input: PlantRootInput): Promise<Result<OutlineChange, AppError>> {
    const at = toIso(this.#clock.now());
    const { seriesId } = input;

    const mutated = await this.#store.mutate(seriesId, (document) => {
      if (document.nodes.some((node) => node.level === 'series')) {
        return err(
          new ConflictError({
            message: `The outline for ${seriesId} already has a series root`,
            context: { reason: 'outline-level-exists', level: 'series', seriesId },
          }),
        );
      }

      const root = StoryNode.parse({
        id: seriesId,
        parentId: null,
        level: 'series',
        ordinal: 1,
        title: input.title,
        summary: input.premise,
        // The root is bound to its own summary: the brief is what the series was asked
        // to be, and binding it to nothing would make the first expansion's echo check
        // vacuous exactly where the tree is widest.
        plannedSummary: input.premise,
        status: 'expanded',
        roleId: null,
        provenance: { source: 'author', parents: [], createdAt: at, costNanoUsd: 0 },
        spentNanoUsd: 0,
        history: [],
      });

      return ok({
        ...document,
        context: storedContextOf(input.context ?? contextFrom(input.title, input.premise)),
        styleBibleId: input.styleBibleId ?? document.styleBibleId,
        nodes: [root],
      });
    });
    if (isErr(mutated)) return mutated;

    return ok({
      expansion: StoryExpansion.parse({
        seriesId,
        level: 'series',
        nodes: mutated.value.nodes.filter((node) => node.level === 'series'),
        spentNanoUsd: 0,
      }),
      traces: [],
    });
  }

  /**
   * Grows the tree by exactly one level.
   *
   * The level below the deepest one that exists, and no other. A request for a level
   * whose parents do not exist is a conflict rather than a silent no-op, because the
   * caller asked for something the tree cannot answer yet and needs to be told which
   * level to build first.
   */
  async expandLevel(
    deps: StoryEngineDeps,
    seriesId: SeriesId,
    level: OutlineLevel,
    options: ExpandLevelOptions = {},
  ): Promise<Result<OutlineChange, AppError>> {
    const loaded = await this.#store.load(seriesId);
    if (isErr(loaded)) return loaded;
    const document = loaded.value;

    const parentLevel = parentLevelOf(level);
    if (parentLevel === undefined) {
      return err(
        new ValidationError({
          message: '"series" is planted from the premise, not expanded - POST the level below it',
          context: { reason: 'series-is-not-an-expansion', level },
        }),
      );
    }

    const context = document.context;
    if (context === null) {
      return err(
        new ConflictError({
          message: `The outline for ${seriesId} has no series root yet; expand "series" first`,
          context: { reason: 'outline-level-skip', level, parentLevel: 'series', seriesId },
        }),
      );
    }

    const parents = document.nodes
      .filter((node) => node.level === parentLevel)
      .sort((left, right) => left.ordinal - right.ordinal);
    if (parents.length === 0) {
      return err(
        new ConflictError({
          message: `"${level}" cannot be expanded before "${parentLevel}" exists`,
          context: { reason: 'outline-level-skip', level, parentLevel, seriesId },
        }),
      );
    }
    if (document.nodes.some((node) => node.level === level)) {
      return err(
        new ConflictError({
          message: `"${level}" has already been expanded; regenerate a node instead`,
          context: { reason: 'outline-level-exists', level, seriesId },
        }),
      );
    }

    const grown = await this.#growChildren(deps, document, parents, level, options);
    if (isErr(grown)) return grown;

    const saved = await this.#store.save({
      ...document,
      nodes: [...document.nodes, ...grown.value.nodes],
    });
    if (isErr(saved)) return saved;

    return ok({
      expansion: StoryExpansion.parse({
        seriesId,
        level,
        nodes: grown.value.nodes,
        spentNanoUsd: grown.value.spentNanoUsd,
      }),
      traces: grown.value.traces,
    });
  }

  /**
   * Rewrites one node, and decides what happens under it.
   *
   * The previous version is appended to `history` before the new text lands, because an
   * edit that loses what it replaced is not an edit a person can undo. `keep` marks
   * every descendant `stale` rather than deleting it: the child's text is still worth
   * reading, it is simply no longer answering the instruction above it.
   */
  async editNode(
    nodeId: string,
    edit: StoryNodeEdit,
  ): Promise<Result<{ readonly node: StoryNode; readonly seriesId: SeriesId }, AppError>> {
    const located = await this.#locate(nodeId);
    if (isErr(located)) return located;
    const { document } = located.value;
    const at = toIso(this.#clock.now());

    let edited: StoryNode | undefined;
    const saved = await this.#store.mutate(document.seriesId, (current) => {
      const node = current.nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined) return err(new NotFoundError('story node', nodeId));

      edited = StoryNode.parse({
        ...node,
        title: edit.title,
        summary: edit.summary,
        status: 'expanded',
        // An authored node has no role: the six named roles are model personas, and
        // attributing a human's sentence to one of them corrupts the ledger.
        roleId: null,
        provenance: {
          source: 'author',
          parents: node.parentId === null ? [] : [node.parentId],
          createdAt: at,
          costNanoUsd: 0,
        },
        history: [
          ...node.history,
          {
            ordinal: node.history.length + 1,
            title: node.title,
            summary: node.summary,
            at: node.provenance?.createdAt ?? at,
          },
        ].slice(-32),
      });

      const descendants = new Set(descendantIdsOf(current.nodes, nodeId));
      const nodes = current.nodes
        .map((candidate) => {
          if (candidate.id === nodeId) return edited ?? candidate;
          if (!descendants.has(candidate.id)) return candidate;
          return edit.children === 'keep' ? { ...candidate, status: 'stale' as const } : candidate;
        })
        .filter((candidate) => edit.children === 'keep' || !descendants.has(candidate.id));

      return ok({ ...current, nodes });
    });
    if (isErr(saved)) return saved;
    if (edited === undefined) return err(new NotFoundError('story node', nodeId));

    return ok({ node: edited, seriesId: document.seriesId });
  }

  /**
   * Rebuilds one node's children, and only that node's.
   *
   * A sibling's subtree is untouched - that is what makes this different from "start
   * again", and it is the property the studio asserts. The old subtree is dropped rather
   * than marked: the caller asked for a *replacement*, and two generations of children
   * under one parent is not a state the tree can represent.
   */
  async regenerateNode(
    deps: StoryEngineDeps,
    nodeId: string,
    options: ExpandLevelOptions = {},
  ): Promise<Result<OutlineChange, AppError>> {
    const located = await this.#locate(nodeId);
    if (isErr(located)) return located;
    const { document, node } = located.value;

    const context = document.context;
    if (context === null) {
      return err(
        new ConflictError({
          message: `The outline for ${document.seriesId} has no context to expand against`,
          context: { reason: 'outline-has-no-context', seriesId: document.seriesId },
        }),
      );
    }

    const childLevel = childLevelOf(node.level);
    if (childLevel === undefined) {
      return err(
        new ValidationError({
          message: `Nothing exists below "${node.level}"; it is the leaf of the story tree`,
          context: { reason: 'no-child-level', level: node.level, nodeId },
        }),
      );
    }

    const grown = await this.#growChildren(deps, document, [node], childLevel, options);
    if (isErr(grown)) return grown;

    const dropped = new Set(descendantIdsOf(document.nodes, nodeId));
    const saved = await this.#store.save({
      ...document,
      nodes: [
        ...document.nodes.filter((candidate) => !dropped.has(candidate.id)),
        ...grown.value.nodes,
      ],
    });
    if (isErr(saved)) return saved;

    return ok({
      expansion: StoryExpansion.parse({
        seriesId: document.seriesId,
        level: childLevel,
        nodes: grown.value.nodes,
        spentNanoUsd: grown.value.spentNanoUsd,
      }),
      traces: grown.value.traces,
    });
  }

  /**
   * One expansion call per parent, in ordinal order.
   *
   * Ordinal order rather than array order because a replay has to produce the same ids
   * in the same sequence, and the array order is whatever the last write happened to
   * leave behind.
   */
  async #growChildren(
    deps: StoryEngineDeps,
    document: StoryDocument,
    parents: readonly StoryNode[],
    level: OutlineLevel,
    options: ExpandLevelOptions,
  ): Promise<
    Result<
      { nodes: StoryNode[]; spentNanoUsd: number; traces: readonly StructuredTrace[] },
      AppError
    >
  > {
    const stored = document.context;
    if (stored === null) {
      return err(
        new ConflictError({
          message: `The outline for ${document.seriesId} has no context to expand against`,
          context: { reason: 'outline-has-no-context', seriesId: document.seriesId },
        }),
      );
    }
    const context = outlineContextOf(stored);
    const useCase = new ExpandOutlineLevelUseCase(deps);

    const nodes: StoryNode[] = [];
    const traces: StructuredTrace[] = [];
    let spent = 0;

    for (const parent of parents) {
      const siblings = document.nodes
        .filter((candidate) => candidate.level === parent.level && candidate.id !== parent.id)
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((candidate) => `${candidate.title}: ${candidate.summary}`);

      const expansion = await useCase.execute({
        context,
        parent: {
          level: parent.level,
          title: parent.title,
          summary: parent.summary,
          plannedSummary: parent.plannedSummary,
        },
        targetLevel: level,
        parentSiblingSummaries: siblings,
        ...(options.childCount === undefined ? {} : { childCount: options.childCount }),
        ...(options.directive === undefined ? {} : { directive: options.directive }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (isErr(expansion)) return expansion;

      const { trace } = expansion.value;
      traces.push(trace);
      spent += trace.costNanoUsd;
      nodes.push(
        ...this.#toNodes(document.seriesId, parent, level, expansion.value.children, {
          model: trace.modelId,
          // Spread across the children rather than attributed to one of them: the call
          // produced all of them, and a per-node figure that summed to more than the
          // call cost would make the run's ledger disagree with itself.
          costNanoUsd: Math.round(trace.costNanoUsd / Math.max(1, expansion.value.children.length)),
        }),
      );
    }

    return ok({ nodes, spentNanoUsd: spent, traces });
  }

  #toNodes(
    seriesId: SeriesId,
    parent: StoryNode,
    level: OutlineLevel,
    children: readonly OutlineChildDraft[],
    provenance: { readonly model: string; readonly costNanoUsd: number },
  ): StoryNode[] {
    const at = toIso(this.#clock.now());
    const mint = MINT_NODE_ID[level];

    return children.map((child) =>
      StoryNode.parse({
        id: mint(this.#ids, seriesId),
        parentId: parent.id,
        level,
        ordinal: child.ordinal,
        title: child.title,
        summary: child.summary,
        plannedSummary: child.plannedSummary,
        status: 'expanded',
        roleId: 'screenwriter',
        provenance: {
          source: 'llm',
          model: provenance.model,
          parents: [parent.id],
          createdAt: at,
          costNanoUsd: provenance.costNanoUsd,
        },
        spentNanoUsd: provenance.costNanoUsd,
        history: [],
      }),
    );
  }

  /**
   * Finds the series a node belongs to.
   *
   * `PATCH /api/story/nodes/:nodeId` addresses a node without naming its series, which
   * is the right shape for the client - a selected node in a tree is one id - and the
   * wrong shape for a store that is one file per series. So the documents are scanned.
   * That is linear in the number of series and it is the honest cost of there being no
   * `story_nodes` table; when the migration lands this becomes an indexed lookup and
   * nothing above it changes.
   */
  async #locate(
    nodeId: string,
  ): Promise<Result<{ document: StoryDocument; node: StoryNode }, AppError>> {
    const documents = await this.#store.all();
    if (isErr(documents)) return documents;

    for (const document of documents.value) {
      const node = document.nodes.find((candidate) => candidate.id === nodeId);
      if (node !== undefined) return ok({ document, node });
    }
    return err(new NotFoundError('story node', nodeId));
  }
}

// ── context, both ways ──────────────────────────────────────────────────────

/** The engine's `OutlineContext`, from what was stored. */
export function outlineContextOf(stored: StoredOutlineContext): OutlineContext {
  return {
    seriesTitle: stored.seriesTitle,
    premise: stored.premise,
    themes: stored.themes,
    tone: stored.tone,
    genre: stored.genre,
    worldRules: stored.worldRules,
    canonPolicy: stored.canonPolicy,
    ...(stored.episodeDurationMs === undefined
      ? {}
      : { episodeDurationMs: stored.episodeDurationMs }),
  };
}

/** The stored form, from the engine's. */
export function storedContextOf(context: OutlineContext): StoredOutlineContext {
  return {
    seriesTitle: context.seriesTitle,
    premise: context.premise,
    themes: [...context.themes],
    tone: [...context.tone],
    genre: [...context.genre],
    worldRules: [...context.worldRules],
    canonPolicy: context.canonPolicy,
    ...(context.episodeDurationMs === undefined
      ? {}
      : { episodeDurationMs: context.episodeDurationMs }),
  };
}

/**
 * The thinnest honest context: the two things a `SeriesCard` actually knows.
 *
 * Themes, tone and genre are left empty rather than guessed. `inlineList` renders an
 * empty list as "none recorded", which tells the outliner it has not been told - and
 * that is a different instruction from a plausible list nobody chose.
 */
export function contextFrom(title: string, premise: string): OutlineContext {
  return {
    seriesTitle: title,
    premise,
    themes: [],
    tone: [],
    genre: [],
    worldRules: [],
    canonPolicy: DEFAULT_CANON_POLICY,
  };
}

/** An empty document for a series that has never been outlined. Re-exported for callers. */
export { emptyStoryDocument };
