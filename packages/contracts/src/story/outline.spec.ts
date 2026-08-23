/**
 * The authoring document and its storage projection, and the seam between them.
 *
 * `Episode` embeds whole scenes; `EpisodeOutline` names them. The tests here are about
 * three things and nothing else: that the projection is *derived* rather than
 * hand-copied, that the round trip loses nothing, and that the invariants the authoring
 * form enforces are also enforced on the form that is actually written to disk.
 */

import { at } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  Act,
  ActOutline,
  Episode,
  EpisodeOutline,
  Scene,
  Sequence,
  SequenceOutline,
  SeriesBible,
  episodeScenes,
  fromEpisodeOutline,
  toActOutline,
  toEpisodeOutline,
  toSequenceOutline,
} from './story-bible';
import { FIXTURE_IDS, twoEpisodeSeriesBible } from './__fixtures__/two-episode-series';
import { fixtureId, issuePaths } from './__fixtures__/support';

const bible = SeriesBible.parse(twoEpisodeSeriesBible);
const season = at(bible.seasons, 0, 'season');
const episodeOne = at(season.episodes, 0, 'episode');
const episodeTwo = at(season.episodes, 1, 'episode');
const actOne = at(episodeOne.acts, 0, 'act');
const sequenceOne = at(actOne.sequences, 0, 'sequence');

/**
 * A Zod object's shape, indexable by a runtime key.
 *
 * The shape's own type names each field, which is exactly what a loop comparing two
 * shapes cannot use - and the comparison is the point of these tests.
 */
type Shape = Readonly<Record<string, z.ZodType>>;

// ── the projection is derived, not written out ──────────────────────────────

describe('the outline schemas are derived from the authoring schemas', () => {
  it('replaces exactly one field on a sequence and touches nothing else', () => {
    expect(Object.keys(SequenceOutline.shape).sort()).toEqual(
      [...Object.keys(Sequence.shape).filter((key) => key !== 'scenes'), 'sceneIds'].sort(),
    );
  });

  it('keeps the same key set on an act and an episode, only the nesting changes', () => {
    expect(Object.keys(ActOutline.shape).sort()).toEqual(Object.keys(Act.shape).sort());
    expect(Object.keys(EpisodeOutline.shape).sort()).toEqual(Object.keys(Episode.shape).sort());
  });

  it('inherits every shared field verbatim, which is what a hand-written copy would not', () => {
    // The test that earns the `.omit()` + `.extend()` derivation. A field added to
    // `Sequence` - or a description reworded on one - lands in the projection on the
    // next compile; a hand-written outline would drift here first and silently drop the
    // new field on its way to disk second.
    const sequenceOutlineShape: Shape = SequenceOutline.shape;
    for (const [key, schema] of Object.entries(Sequence.shape)) {
      if (key === 'scenes') continue;
      expect(sequenceOutlineShape[key]?.description, key).toBe(schema.description);
    }
    const episodeOutlineShape: Shape = EpisodeOutline.shape;
    for (const [key, schema] of Object.entries(Episode.shape)) {
      if (key === 'acts') continue;
      expect(episodeOutlineShape[key]?.description, key).toBe(schema.description);
    }
  });

  it('stays strict, so a field dropped from the authoring form cannot linger in storage', () => {
    const outline = toEpisodeOutline(episodeOne);
    expect(EpisodeOutline.safeParse({ ...outline, scenes: [] }).success).toBe(false);
  });
});

// ── the round trip ──────────────────────────────────────────────────────────

describe('projecting and rehydrating an episode', () => {
  it('produces a valid outline that names every scene in playing order', () => {
    const outline = EpisodeOutline.parse(toEpisodeOutline(episodeOne));
    const named = outline.acts.flatMap((act) =>
      act.sequences.flatMap((sequence) => sequence.sceneIds),
    );
    expect(named).toEqual(episodeScenes(episodeOne).map((scene) => scene.id));
    expect(named).toEqual([FIXTURE_IDS.sceneOne]);
  });

  it('carries the episode fields across unchanged, including the optional ones', () => {
    const outline = toEpisodeOutline(episodeOne);
    expect(outline.id).toBe(episodeOne.id);
    expect(outline.status).toBe(episodeOne.status);
    expect(outline.coldOpen).toBe(episodeOne.coldOpen);
    expect(outline.opensLoops).toEqual(episodeOne.opensLoops);
  });

  it('omits an absent optional rather than writing an explicit undefined', () => {
    // `exactOptionalPropertyTypes` is on, and storage round-trips this through JSON:
    // `{cliffhanger: undefined}` and `{}` are different documents, and only one of them
    // re-parses.
    const outline = toEpisodeOutline(episodeTwo);
    expect('coldOpen' in outline).toBe(false);
    expect(JSON.parse(JSON.stringify(outline))).toEqual(outline);
  });

  it('rebuilds the identical authoring document from the outline and the scene rows', () => {
    const outline = toEpisodeOutline(episodeOne);
    const result = fromEpisodeOutline(outline, episodeScenes(episodeOne));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(episodeOne);
    // And the rebuilt tree is still a legal episode, not merely a structural match.
    expect(Episode.parse(result.value)).toEqual(episodeOne);
  });

  it('resolves scenes handed to it in any order, because a row order is not a playing order', () => {
    const outline = toEpisodeOutline(episodeOne);
    const shuffled = [...episodeScenes(episodeOne)].reverse();
    const result = fromEpisodeOutline(outline, shuffled);
    expect(result.ok && result.value).toEqual(episodeOne);
  });

  it('names the scenes it could not find rather than failing generically', () => {
    // The list *is* the diagnosis: the two tables were written out of step, and the
    // operator needs to know which rows to go and look for.
    const missingId = fixtureId('scn', 99);
    const outline = toEpisodeOutline(episodeOne);
    const result = fromEpisodeOutline(outline, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual([FIXTURE_IDS.sceneOne]);
    expect(result.error).not.toContain(missingId);
  });

  it('reports every missing scene, not just the first', () => {
    const both = fromEpisodeOutline(toEpisodeOutline(episodeOne), []);
    const wide = fromEpisodeOutline(
      EpisodeOutline.parse({
        ...toEpisodeOutline(episodeOne),
        acts: toEpisodeOutline(episodeOne).acts.map((act) => ({
          ...act,
          sequences: act.sequences.map((sequence) => ({
            ...sequence,
            sceneIds: [FIXTURE_IDS.sceneOne, FIXTURE_IDS.sceneTwo],
          })),
        })),
      }),
      [],
    );
    expect(both.ok).toBe(false);
    expect(wide.ok).toBe(false);
    if (wide.ok) return;
    expect(wide.error).toEqual([FIXTURE_IDS.sceneOne, FIXTURE_IDS.sceneTwo]);
  });

  it('projects one sequence and one act on their own', () => {
    expect(toSequenceOutline(sequenceOne).sceneIds).toEqual([FIXTURE_IDS.sceneOne]);
    expect(toActOutline(actOne).sequences.at(0)?.sceneIds).toEqual([FIXTURE_IDS.sceneOne]);
  });

  it('flattens the scenes of a whole episode in playing order', () => {
    const scenes = episodeScenes(episodeOne);
    expect(scenes.map((scene) => scene.id)).toEqual([FIXTURE_IDS.sceneOne]);
    expect(Scene.parse(scenes[0])).toEqual(scenes[0]);
  });
});

// ── the invariants follow the data to storage ───────────────────────────────

describe('the stored projection enforces what the authoring form enforces', () => {
  function outlineWith(overrides: Record<string, unknown>): unknown {
    return { ...toEpisodeOutline(episodeOne), ...overrides };
  }

  it('rejects act ordinals that are not 1..n', () => {
    const outline = toEpisodeOutline(episodeOne);
    const result = EpisodeOutline.safeParse(
      outlineWith({ acts: outline.acts.map((act) => ({ ...act, ordinal: 4 })) }),
    );
    expect(issuePaths(result)).toContain('acts');
  });

  it('rejects sequence ordinals that are not 1..n', () => {
    const outline = toEpisodeOutline(episodeOne);
    const broken = outline.acts.map((act) => ({
      ...act,
      sequences: act.sequences.map((sequence) => ({ ...sequence, ordinal: 7 })),
    }));
    const result = EpisodeOutline.safeParse(outlineWith({ acts: broken }));
    expect(issuePaths(result)).toContain('acts.0.sequences');
  });

  it('rejects an aired episode with no air date, on the form that is actually written', () => {
    // Non-negotiable #7's bookkeeping. An invariant enforced only on the authoring
    // document is an invariant nothing enforces, because the authoring document is not
    // what gets stored.
    const result = EpisodeOutline.safeParse(outlineWith({ status: 'aired' }));
    expect(issuePaths(result)).toEqual(['airedAt']);
  });

  it('rejects an unaired episode carrying an air date', () => {
    const result = EpisodeOutline.safeParse(
      outlineWith({ status: 'scripted', airedAt: '2026-06-01T00:00:00Z' }),
    );
    expect(issuePaths(result)).toEqual(['airedAt']);
  });

  it('accepts an aired episode that records when', () => {
    expect(
      EpisodeOutline.safeParse(outlineWith({ status: 'aired', airedAt: '2026-06-01T00:00:00Z' }))
        .success,
    ).toBe(true);
  });

  it('rejects a sequence outline that names no scene at all', () => {
    const outline = toEpisodeOutline(episodeOne);
    const empty = outline.acts.map((act) => ({
      ...act,
      sequences: act.sequences.map((sequence) => ({ ...sequence, sceneIds: [] })),
    }));
    expect(EpisodeOutline.safeParse(outlineWith({ acts: empty })).success).toBe(false);
  });

  it('rejects a scene reference that is not a scene id', () => {
    const result = SequenceOutline.safeParse({
      ...toSequenceOutline(sequenceOne),
      sceneIds: [FIXTURE_IDS.episodeOne],
    });
    expect(issuePaths(result)).toEqual(['sceneIds.0']);
  });

  it('is a fixed point: re-parsing a parsed outline changes nothing', () => {
    const once = EpisodeOutline.parse(toEpisodeOutline(episodeOne));
    const twice = EpisodeOutline.parse(once);
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('is an object schema like its authoring counterpart, not a wrapper', () => {
    expect(z.toJSONSchema(EpisodeOutline, { io: 'input' }).additionalProperties).toBe(false);
  });
});
