/**
 * The story tree on the wire, in the shape the Story screen already validates against.
 *
 * **Read this before adding to it.** Non-negotiable #5 puts every shape in
 * `@rv/contracts`, and everything below is a gap in that package rather than a licence
 * to declare shapes locally. It is declared here for one reason: the studio declared
 * the same shapes first, in `apps/web/src/features/story/api/story-tree.ts`, and its
 * own header says they "belong in `@rv/contracts/src/story/` beside `OutlineEnvelope`"
 * when the routes land. Until someone moves them, a *third* definition would be exactly
 * the drift the rule exists to prevent, so this file is a deliberate mirror and is
 * documented as one. The gap is reported in `modules/story/story.module.ts`.
 *
 * What is mirrored is only what a **flat, partially-built** tree needs and a finished
 * `SeriesBible` cannot express:
 *
 *  - **`level` and `parentId`.** `SeriesBible` is nested and every branch of it is
 *    complete (`sequences: z.array(...).min(1)`). A tree that is still growing has an
 *    act with no sequences yet, and only a flat node list can say so honestly - which
 *    is also what lets one level arrive on its own.
 *  - **`status`.** `stale` is what makes an edit safe: a child whose parent moved under
 *    it is marked, never deleted, so "keep the children" is a real answer.
 *  - **`history`.** The previous version has to survive an edit.
 *
 * The *content* of a node is `OutlineEnvelope` from `@rv/contracts`, spread in, so a
 * field renamed upstream fails this build rather than drifting.
 */

import {
  IsoInstant,
  Label,
  NanoUsdAmount,
  OutlineEnvelope,
  Prose,
  Provenance,
  SeriesId,
} from '@rv/contracts';
import { z } from 'zod';

// ── the seven levels ────────────────────────────────────────────────────────

/**
 * Series → Season → Episode → Act → Sequence → Scene → Beat.
 *
 * A chain, not a graph: every level has exactly one parent level and at most one child
 * level. Declared as an ordered array because that is what makes "you skipped a level"
 * a thing the code detects rather than a thing a reviewer notices.
 *
 * The same seven, in the same order, as `OUTLINE_LEVELS` in `@rv/story-engine` and
 * docs/02 §1. The engine's copy is the one that *guards* an expansion
 * (`checkSingleLevelDescent`); this one only names the levels on the wire.
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

/** The level immediately above, or `undefined` at the series root. */
export function parentLevelOf(level: OutlineLevel): OutlineLevel | undefined {
  const index = OUTLINE_LEVELS.indexOf(level);
  return index <= 0 ? undefined : OUTLINE_LEVELS[index - 1];
}

// ── a node ──────────────────────────────────────────────────────────────────

/**
 * Why a node is the colour it is.
 *
 * `stale` is the state that makes an edit safe: the child keeps its text and is marked
 * rather than thrown away.
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
 * `id` is a plain bounded string rather than one of the seven branded id types: the
 * node is addressed generically here - a map key, a `parentId` pointing at whichever
 * level is above - and a seven-way union would have to be narrowed at every one of
 * those sites to say nothing extra. The branded ids still exist and are what the
 * *minter* produces; this is the address, not the identity.
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

// ── the request bodies ──────────────────────────────────────────────────────

const ChildCountBounds = z.strictObject({
  min: z.number().int().positive().max(64),
  max: z.number().int().positive().max(64),
});

/**
 * `POST /api/series/:seriesId/outline/expand`.
 *
 * There is no `to` and no `depth`, and that absence is the feature. A body that could
 * name a *target* depth would let a client ask for the scenes of a series in one
 * request, and the DOC discipline the outliner rests on - every child bound to what its
 * parent asked for - would be bypassed in the transport instead of in the engine. The
 * studio builds "the rest of the tree" as a loop over this route, which is the only way
 * it may be built.
 */
export const ExpandOutlineBody = z.strictObject({
  level: OutlineLevel,
  /** Bounds on how many children each parent gets. Absent means "as many as it needs". */
  childCount: ChildCountBounds.optional(),
});
export type ExpandOutlineBody = z.infer<typeof ExpandOutlineBody>;

/**
 * `PATCH /api/series/:id` - the premise, in the author's own words.
 *
 * The Story screen shows the premise beside the one button that spends money on it, and
 * until now had no way to correct it. Title and premise only: `hasBible` is set by S2
 * from what S2 produced, and `projectId` would move the series between projects, which
 * is not an edit.
 */
export const UpdateSeriesBody = z
  .strictObject({ title: Label.optional(), premise: Prose.optional() })
  .refine((body) => body.title !== undefined || body.premise !== undefined, {
    message: 'a patch that changes nothing is a mistake, not a no-op',
  });
export type UpdateSeriesBody = z.infer<typeof UpdateSeriesBody>;

// ── tree arithmetic ─────────────────────────────────────────────────────────

/** Descendants of `nodeId`, deepest first, so a caller can drop a subtree safely. */
export function descendantIdsOf(nodes: readonly StoryNode[], nodeId: string): readonly string[] {
  const children = nodes.filter((node) => node.parentId === nodeId);
  return children.flatMap((child) => [...descendantIdsOf(nodes, child.id), child.id]);
}

/** The deepest level that has at least one node, or `undefined` for an empty tree. */
export function deepestLevel(nodes: readonly StoryNode[]): OutlineLevel | undefined {
  let deepest: OutlineLevel | undefined;
  for (const level of OUTLINE_LEVELS) {
    if (nodes.some((node) => node.level === level)) deepest = level;
  }
  return deepest;
}
