/**
 * The story tree, in the shape this screen reads it.
 *
 * Nothing here restates a shape `@rv/contracts` already owns. The *content* of a node
 * is `OutlineEnvelope` — `ordinal`, `title`, `summary`, `plannedSummary` — spread in
 * from the contract, so a field renamed upstream fails this build rather than drifting.
 * What is added is only what a *flat, partially-built* tree needs and a finished
 * `SeriesBible` cannot express:
 *
 *  - **`level` and `parentId`.** `SeriesBible` is a nested document whose every branch
 *    is complete. A tree that is still growing has an act with no sequences yet, and a
 *    nested schema calls that invalid (`sequences: z.array(...).min(1)`). A flat node
 *    list is the only honest representation of a half-built outline, and it is also
 *    what lets a level arrive on its own.
 *  - **`status`.** `stale` is the whole point of RV-205: an edit must not silently
 *    invalidate its children, so a child whose parent moved under it is marked, not
 *    deleted.
 *  - **`history`.** RV-091 requires the previous version to survive an edit.
 *
 * **Report:** `POST /api/series/:seriesId/outline/expand`, `GET /api/series/:seriesId/outline`
 * and `PATCH /api/story/nodes/:nodeId` do not exist. When they land, these shapes belong
 * in `@rv/contracts/src/story/` beside `OutlineEnvelope`, and this file becomes a
 * re-export. `OUTLINE_LEVELS` in particular is already spelled out twice — in the story
 * engine's outliner and in docs/02 §1 — and belongs upstream with them.
 */

import {
  IsoInstant,
  Label,
  NanoUsdAmount,
  OutlineEnvelope,
  PIPELINE_STAGES,
  type PipelineStage,
  Prose,
  Provenance,
  SeriesId,
  pipelineStageIndex,
} from '@rv/contracts';
import { z } from 'zod';

// ── the seven levels ────────────────────────────────────────────────────────

/**
 * Series → Season → Episode → Act → Sequence → Scene → Beat.
 *
 * A chain, not a graph: every level has exactly one parent level and at most one child
 * level. Declared as an ordered array because that is what makes "you skipped a level"
 * a thing the code can detect rather than a thing a reviewer has to notice — and the
 * discipline of descending one at a time is the reason the story holds together.
 */
export const OUTLINE_LEVELS = [
  'series',
  'season',
  'episode',
  'act',
  'sequence',
  'scene',
  'beat',
] as const;

export const OutlineLevel = z.enum(OUTLINE_LEVELS);
export type OutlineLevel = z.infer<typeof OutlineLevel>;

/** The level immediately below, or `undefined` at the leaf. */
export function childLevelOf(level: OutlineLevel): OutlineLevel | undefined {
  return OUTLINE_LEVELS[OUTLINE_LEVELS.indexOf(level) + 1];
}

/** How deep a level sits, starting at 0 for the series root. */
export function levelDepth(level: OutlineLevel): number {
  return OUTLINE_LEVELS.indexOf(level);
}

// ── a node ──────────────────────────────────────────────────────────────────

/**
 * Why a node is the colour it is.
 *
 * `stale` is the state that makes an edit safe: the child keeps its text and is marked
 * rather than thrown away, so "keep the children" is a real option and not a promise
 * the data model cannot honour.
 */
export const STORY_NODE_STATUSES = ['planned', 'generating', 'expanded', 'stale'] as const;
export const StoryNodeStatus = z.enum(STORY_NODE_STATUSES);
export type StoryNodeStatus = z.infer<typeof StoryNodeStatus>;

/** The six named roles the story stages are staffed by, as the ledger records them. */
export const STORY_ROLE_IDS = [
  'producer',
  'screenwriter',
  'art-director',
  'director',
  'actor',
  'continuity-editor',
] as const;
export const StoryRoleId = z.enum(STORY_ROLE_IDS);
export type StoryRoleId = z.infer<typeof StoryRoleId>;

/** One superseded version of a node. Appended on edit; never replaced. */
export const StoryNodeVersion = z.strictObject({
  ordinal: z.number().int().positive(),
  title: Label,
  summary: Prose,
  at: IsoInstant,
});
export type StoryNodeVersion = z.infer<typeof StoryNodeVersion>;

/**
 * One node of the tree, at any level.
 *
 * `id` is a plain bounded string rather than one of the seven branded id types. The
 * branding is real and useful where a function takes exactly an `ActId`; here the node
 * is addressed generically — a map key, a selection, a `parentId` that points at
 * whichever level is above — and a seven-way union would have to be narrowed at every
 * one of those sites to say nothing extra.
 */
export const StoryNode = z.strictObject({
  id: z.string().min(1).max(64),
  parentId: z.string().min(1).max(64).nullable(),
  level: OutlineLevel,
  ...OutlineEnvelope.shape,
  status: StoryNodeStatus.default('expanded'),
  /** Which named role wrote it. `null` for a node the author typed themselves. */
  roleId: StoryRoleId.nullable().default(null),
  provenance: Provenance.optional(),
  spentNanoUsd: NanoUsdAmount.default(0),
  history: z.array(StoryNodeVersion).max(32).default([]),
});
export type StoryNode = z.infer<typeof StoryNode>;

export const StoryTree = z.strictObject({
  seriesId: SeriesId,
  nodes: z.array(StoryNode).max(8192).default([]),
});
export type StoryTree = z.infer<typeof StoryTree>;

/** One level's worth of children, as a single expansion answers with them. */
export const StoryExpansion = z.strictObject({
  seriesId: SeriesId,
  level: OutlineLevel,
  nodes: z.array(StoryNode).max(4096).default([]),
  spentNanoUsd: NanoUsdAmount.default(0),
});
export type StoryExpansion = z.infer<typeof StoryExpansion>;

/** What an edit is allowed to change, and what happens to the children afterwards. */
export const CHILD_DISPOSITIONS = ['keep', 're-expand'] as const;
export const ChildDisposition = z.enum(CHILD_DISPOSITIONS);
export type ChildDisposition = z.infer<typeof ChildDisposition>;

export const StoryNodeEdit = z.strictObject({
  title: Label,
  summary: Prose,
  children: ChildDisposition,
});
export type StoryNodeEdit = z.infer<typeof StoryNodeEdit>;

// ── what an edit affects, computed before it happens ────────────────────────

/**
 * The stage an outline level is first consumed by.
 *
 * RV-091 fixes the leaf case exactly: an edited `Beat` marks S7–S11 stale and leaves
 * S0–S6 complete. The levels above a beat are read earlier — the cast (S3) and the
 * world (S4) are derived from the episode outline, not from its beats — so an edit up
 * there reaches further down the pipeline, not less far.
 *
 * **Report:** this is the stage graph of RV-007 mirrored in a client, which is one copy
 * too many. It belongs in `@rv/contracts` beside `PIPELINE_STAGES` so the API, the CLI
 * and this screen answer "what did I just invalidate" identically.
 */
const FIRST_CONSUMER: Readonly<Record<OutlineLevel, PipelineStage>> = {
  series: 'cast',
  season: 'cast',
  episode: 'cast',
  act: 'sequence',
  sequence: 'sequence',
  scene: 'sequence',
  beat: 'sequence',
};

export interface EditImpact {
  /** Every descendant, at any depth. */
  readonly childCount: number;
  /** The levels those descendants sit at, in descent order. */
  readonly levels: readonly OutlineLevel[];
  /** Pipeline stages this edit invalidates, in pipeline order. */
  readonly staleStages: readonly PipelineStage[];
}

/**
 * What editing this node touches — answered before the edit is committed.
 *
 * A pure function of the tree already on screen, which is what makes it honest to show
 * *first*: nothing here is a prediction about a server round trip. The count is the
 * number the user is actually deciding about when they choose between keeping the
 * children and rewriting them.
 */
export function editImpactOf(tree: StoryTree, nodeId: string): EditImpact {
  const byParent = new Map<string, StoryNode[]>();
  for (const node of tree.nodes) {
    if (node.parentId === null) continue;
    const bucket = byParent.get(node.parentId);
    if (bucket === undefined) byParent.set(node.parentId, [node]);
    else bucket.push(node);
  }

  const found: StoryNode[] = [];
  const frontier = [nodeId];
  while (frontier.length > 0) {
    const current = frontier.pop();
    if (current === undefined) continue;
    for (const child of byParent.get(current) ?? []) {
      found.push(child);
      frontier.push(child.id);
    }
  }

  const levels = OUTLINE_LEVELS.filter((level) => found.some((node) => node.level === level));

  const self = tree.nodes.find((node) => node.id === nodeId);
  const from = self === undefined ? 'sequence' : FIRST_CONSUMER[self.level];
  const staleStages = PIPELINE_STAGES.filter(
    (stage) => pipelineStageIndex(stage) >= pipelineStageIndex(from),
  );

  return { childCount: found.length, levels, staleStages };
}

/** Descendants of `nodeId`, deepest first, so a caller can drop a subtree safely. */
export function descendantIdsOf(tree: StoryTree, nodeId: string): readonly string[] {
  const children = tree.nodes.filter((node) => node.parentId === nodeId);
  return children.flatMap((child) => [...descendantIdsOf(tree, child.id), child.id]);
}
