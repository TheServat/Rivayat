import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  FIXTURE_IDS,
  sceneOneShots,
  twoEpisodeSeriesBible,
} from './__fixtures__/two-episode-series';
import { issuePaths } from './__fixtures__/support';
import * as story from './index';
import { Brief as BriefFromModule } from './brief';
import { Shot as ShotFromModule } from './shot';
import { SeriesBible as SeriesBibleFromModule } from './story-bible';

describe('the story barrel', () => {
  it('re-exports the three modules as one flat surface', () => {
    expect(story.SeriesBible).toBe(SeriesBibleFromModule);
    expect(story.Shot).toBe(ShotFromModule);
    expect(story.Brief).toBe(BriefFromModule);
  });

  it('exports the lifecycle table the domain layer validates transitions against', () => {
    expect(story.EPISODE_STATUS_TRANSITIONS.aired).toEqual([]);
  });
});

describe('end to end - a two-episode series with a shot list', () => {
  const bible = story.SeriesBible.parse(twoEpisodeSeriesBible);
  const shots = sceneOneShots.map((raw) => story.Shot.parse(raw));

  it('parses the whole bible without a single repair', () => {
    expect(issuePaths(story.SeriesBible.safeParse(twoEpisodeSeriesBible))).toEqual([]);
  });

  it('holds two episodes in one season', () => {
    expect(bible.seasons).toHaveLength(1);
    expect(bible.seasons[0]?.episodes).toHaveLength(2);
    expect(bible.seasons[0]?.episodes.map((episode) => episode.status)).toEqual([
      'boarded',
      'outlined',
    ]);
  });

  it('carries the parent instruction at every level below the root', () => {
    const season = bible.seasons[0];
    const episode = season?.episodes[0];
    const scene = episode?.acts[0]?.sequences[0]?.scenes[0];
    expect(bible.plannedSummary).toBeNull(); // the root's parent is the brief
    expect(season?.plannedSummary).not.toBeNull();
    expect(episode?.plannedSummary).not.toBeNull();
    expect(scene?.plannedSummary).not.toBeNull();
    for (const beat of scene?.beats ?? []) {
      expect(beat.plannedSummary).not.toBeNull();
    }
  });

  it('fully specifies exactly one scene, down to three beats', () => {
    const scene = bible.seasons[0]?.episodes[0]?.acts[0]?.sequences[0]?.scenes[0];
    expect(scene?.id).toBe(FIXTURE_IDS.sceneOne);
    expect(scene?.povEntityRef).toBe(FIXTURE_IDS.mahtab);
    expect(scene?.beats.map((beat) => beat.function)).toEqual(['setup', 'catalyst', 'turn']);
    expect(scene?.valueShift).toEqual({
      axis: 'certainty',
      from: 'positive',
      to: 'strong-negative',
    });
  });

  it('numbers siblings from one, contiguously, at every level', () => {
    const season = bible.seasons[0];
    expect(bible.seasons.map((each) => each.ordinal)).toEqual([1]);
    expect(season?.episodes.map((each) => each.ordinal)).toEqual([1, 2]);
    const scene = season?.episodes[0]?.acts[0]?.sequences[0]?.scenes[0];
    expect(scene?.beats.map((each) => each.ordinal)).toEqual([1, 2, 3]);
  });

  it('parses three shots, indexed from zero', () => {
    expect(shots.map((each) => each.index)).toEqual([0, 1, 2]);
    expect(shots.map((each) => each.durationMs).every((ms) => ms > 0)).toBe(true);
  });

  it('covers every beat of the specified scene with exactly one shot, in order', () => {
    const scene = bible.seasons[0]?.episodes[0]?.acts[0]?.sequences[0]?.scenes[0];
    expect(shots.map((each) => each.beatRef)).toEqual(scene?.beats.map((beat) => beat.id));
  });

  it('only ever puts a speaker on screen who is present in the scene', () => {
    const scene = bible.seasons[0]?.episodes[0]?.acts[0]?.sequences[0]?.scenes[0];
    const present = new Set(scene?.presentEntityRefs ?? []);
    const speakers = shots.flatMap((each) => each.dialogue.map((line) => line.speakerRef));
    expect(speakers.length).toBeGreaterThan(0);
    for (const speaker of speakers) {
      expect(present.has(speaker)).toBe(true);
    }
  });

  it('anchors every reframe on a placement that exists in that shot', () => {
    for (const each of shots) {
      const placed = new Set(
        each.layout.flatMap((layer) => layer.instances.map((i) => i.instance)),
      );
      if (each.focusTarget.instance !== null) {
        expect(placed.has(each.focusTarget.instance)).toBe(true);
      }
      for (const action of each.blocking) {
        expect(placed.has(action.instance)).toBe(true);
      }
    }
  });

  it('blocks every action inside its own shot', () => {
    for (const each of shots) {
      for (const action of each.blocking) {
        expect(action.startMs).toBeLessThan(each.durationMs);
        expect(action.startMs + action.durationMs).toBeLessThanOrEqual(each.durationMs);
      }
    }
  });

  it('owes the same crops on every shot as the bible promised to deliver', () => {
    for (const each of shots) {
      expect(each.sceneSpace.reframeTargets).toEqual(bible.targetFormat.deliverables);
      expect(each.sceneSpace.reframeTargets).toContain(each.sceneSpace.masterAspect);
    }
  });

  it('overrides the vertical crop on exactly the shot that needs it', () => {
    const overridden = shots.filter((each) => Object.keys(each.sceneSpace.overrides).length > 0);
    expect(overridden).toHaveLength(1);
    expect(overridden[0]?.sceneSpace.overrides['9:16']).toEqual({
      x: 0.3,
      y: 0,
      width: 0.4,
      height: 1,
    });
  });

  it('leaves the boarded episode able to advance and to fall back one step', () => {
    const episode = bible.seasons[0]?.episodes[0];
    const legal = story.EPISODE_STATUS_TRANSITIONS[episode?.status ?? 'draft'];
    expect(legal).toContain('asset-resolved');
    expect(legal).toContain('scripted');
    expect(legal).not.toContain('aired');
  });

  it('emits JSON Schema for the whole bible and the whole shot, closed at every object', () => {
    for (const schema of [story.SeriesBible, story.Shot]) {
      const json = z.toJSONSchema(schema) as { additionalProperties?: unknown };
      expect(json.additionalProperties).toBe(false);
    }
  });
});
