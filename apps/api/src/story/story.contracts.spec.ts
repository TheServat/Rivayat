/**
 * The tree arithmetic, and the two shapes that carry it.
 *
 * These are small pure functions, and each of them is load-bearing somewhere a mistake
 * would be silent: `descendantIdsOf` decides what an edit marks stale, `deepestLevel`
 * decides what "one more level" means, and the level chain decides whether a request can
 * skip a level at all.
 */

import { describe, expect, it } from 'vitest';

import {
  OUTLINE_LEVELS,
  StoryNode,
  UpdateSeriesBody,
  childLevelOf,
  deepestLevel,
  descendantIdsOf,
  parentLevelOf,
  type StoryNode as StoryNodeType,
} from './story.contracts';

function node(id: string, parentId: string | null, level: string, ordinal = 1): StoryNodeType {
  return StoryNode.parse({
    id,
    parentId,
    level,
    ordinal,
    title: id,
    summary: `What ${id} contains.`,
    plannedSummary: `What ${id} was asked to be.`,
  });
}

describe('the level chain', () => {
  it('is a chain: one parent above, at most one child below', () => {
    for (const [index, level] of OUTLINE_LEVELS.entries()) {
      expect(parentLevelOf(level)).toBe(OUTLINE_LEVELS[index - 1]);
      expect(childLevelOf(level)).toBe(OUTLINE_LEVELS[index + 1]);
    }
  });

  it('has no parent at the root and no child at the leaf', () => {
    expect(parentLevelOf('series')).toBeUndefined();
    expect(childLevelOf('beat')).toBeUndefined();
  });
});

describe('descendantIdsOf', () => {
  const tree = [
    node('root', null, 'series'),
    node('a', 'root', 'season'),
    node('a1', 'a', 'episode', 1),
    node('a2', 'a', 'episode', 2),
    node('a1x', 'a1', 'act'),
    node('b', 'root', 'season', 2),
    node('b1', 'b', 'episode'),
  ];

  it('reaches every depth, deepest first, so a caller can drop a subtree safely', () => {
    expect([...descendantIdsOf(tree, 'a')].sort()).toEqual(['a1', 'a1x', 'a2']);
    // Deepest first: `a1x` comes before its own parent in the list.
    expect(descendantIdsOf(tree, 'a').indexOf('a1x')).toBeLessThan(
      descendantIdsOf(tree, 'a').indexOf('a1'),
    );
  });

  it('does not reach a sibling’s subtree, which is what makes regeneration local', () => {
    expect(descendantIdsOf(tree, 'a')).not.toContain('b1');
  });

  it('answers nothing for a leaf and for an id nobody holds', () => {
    expect(descendantIdsOf(tree, 'a1x')).toEqual([]);
    expect(descendantIdsOf(tree, 'nope')).toEqual([]);
  });
});

describe('deepestLevel', () => {
  it('is the deepest level with a node, not the last one added', () => {
    expect(deepestLevel([node('a1x', 'a1', 'act'), node('root', null, 'series')])).toBe('act');
  });

  it('is undefined for a tree nobody has grown', () => {
    expect(deepestLevel([])).toBeUndefined();
  });
});

describe('StoryNode', () => {
  it('defaults the fields a client should not have to send', () => {
    const parsed = node('a', null, 'series');

    expect(parsed.status).toBe('expanded');
    expect(parsed.roleId).toBeNull();
    expect(parsed.spentNanoUsd).toBe(0);
    expect(parsed.history).toEqual([]);
  });

  it('refuses a node at a level that is not one of the seven', () => {
    expect(StoryNode.safeParse({ ...node('a', null, 'series'), level: 'chapter' }).success).toBe(
      false,
    );
  });
});

describe('UpdateSeriesBody', () => {
  it('accepts either field on its own', () => {
    expect(UpdateSeriesBody.safeParse({ title: 'A new title' }).success).toBe(true);
    expect(UpdateSeriesBody.safeParse({ premise: 'A new premise, in prose.' }).success).toBe(true);
  });

  it('refuses a patch that changes nothing, which is a mistake rather than a no-op', () => {
    expect(UpdateSeriesBody.safeParse({}).success).toBe(false);
  });

  it('refuses a field a patch has no business moving', () => {
    // Moving `projectId` would move the series between projects, and every episode and
    // run pointing at it would silently belong somewhere else.
    expect(UpdateSeriesBody.safeParse({ title: 'x', projectId: 'prj_1' }).success).toBe(false);
  });
});
