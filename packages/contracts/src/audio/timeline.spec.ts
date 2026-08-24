/**
 * The audio timeline, and the one check that keeps it honest against the animation.
 *
 * `checkAgainstMarkers` is the load-bearing test in this file. The decision to give
 * audio its own document instead of widening `AnimationIR.markers` is only defensible if
 * the two are provably in agreement, and that proof is a function returning an empty
 * list. If it can be made to return empty when the documents disagree, the decision was
 * wrong.
 */

import { describe, expect, it } from 'vitest';

import { Ids } from '../primitives/ids';
import { PLAIN_DIRECTION } from './emotion';
import {
  AudioCue,
  AudioTimeline,
  checkAgainstMarkers,
  cueEndMs,
  cuesOnTrack,
  isPendingSynthesis,
  trackForRole,
} from './timeline';

const ids = new Ids();
const NARRATOR = ids.entity();
const MAHTAB = ids.entity();
const SHOT = ids.shot();
const MARKER = ids.marker();

function speechCue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ids.audioCue(),
    track: 'dialogue',
    startMs: 1000,
    durationMs: 2400,
    source: {
      kind: 'speech',
      speakerRef: MAHTAB,
      performer: 'synthetic',
      text: 'او رفت.',
      language: 'fa',
      direction: PLAIN_DIRECTION,
    },
    shotRef: SHOT,
    provenance: {},
    ...overrides,
  };
}

function narrationCue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return speechCue({
    track: 'narration',
    source: {
      kind: 'speech',
      speakerRef: NARRATOR,
      performer: 'human',
      text: 'شب که می‌شود فانوس را روشن می‌کند.',
      language: 'fa',
      direction: PLAIN_DIRECTION,
    },
    ...overrides,
  });
}

function timeline(cues: readonly unknown[]): unknown {
  return { animationRef: 'anm_test', durationMs: 60_000, language: 'fa', cues };
}

describe('AudioCue', () => {
  it('accepts a planned cue with nothing spoken yet', () => {
    const parsed = AudioCue.parse(speechCue({ durationMs: null }));
    expect(parsed.blob).toBeNull();
    expect(parsed.provenance.modelRef).toBeNull();
    expect(parsed.provenance.costNanoUsd).toBeNull();
    expect(isPendingSynthesis(parsed)).toBe(true);
  });

  it('refuses audio whose length nobody measured', () => {
    // The state that silently mistimes a whole track: bytes to play, no idea when the
    // next thing starts.
    const result = AudioCue.safeParse(
      speechCue({
        durationMs: null,
        blob: { sha256: 'b'.repeat(64), mimeType: 'audio/wav', bytes: 1000, durationMs: null },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['durationMs']);
  });

  it('accepts audio measured either on the blob or on the cue', () => {
    const onBlob = AudioCue.safeParse(
      speechCue({
        durationMs: null,
        blob: { sha256: 'b'.repeat(64), mimeType: 'audio/wav', bytes: 1000, durationMs: 2400 },
      }),
    );
    expect(onBlob.success).toBe(true);
  });

  it('refuses a human cue that names a synthesis model', () => {
    const result = AudioCue.safeParse(
      narrationCue({ provenance: { modelRef: 'elevenlabs:eleven_v3' } }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['provenance', 'modelRef']);
  });

  it('refuses a human cue with no window to land in', () => {
    const result = AudioCue.safeParse(narrationCue({ durationMs: null }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['durationMs']);
  });

  it('keeps speech on a speech track and sound off it', () => {
    expect(AudioCue.safeParse(speechCue({ track: 'sfx' })).success).toBe(false);
    expect(
      AudioCue.safeParse({
        id: ids.audioCue(),
        track: 'dialogue',
        startMs: 0,
        source: { kind: 'effect', key: 'sfx/door-creak/slow' },
        provenance: {},
      }).success,
    ).toBe(false);
  });

  it('accepts an effect and a bed on their own tracks', () => {
    expect(
      AudioCue.safeParse({
        id: ids.audioCue(),
        track: 'sfx',
        startMs: 4200,
        source: { kind: 'effect', key: 'sfx/door-creak/slow', loop: false },
        provenance: {},
      }).success,
    ).toBe(true);
    expect(
      AudioCue.safeParse({
        id: ids.audioCue(),
        track: 'ambience',
        startMs: 0,
        source: { kind: 'bed', key: 'ambience/sea/night', mood: 'unresolved', fadeInMs: 1500 },
        provenance: {},
      }).success,
    ).toBe(true);
  });

  it('reports where a cue ends, and treats an unmeasured one as a point', () => {
    expect(cueEndMs(AudioCue.parse(speechCue()))).toBe(3400);
    expect(cueEndMs(AudioCue.parse(speechCue({ durationMs: null })))).toBe(1000);
  });

  it('does not call a human cue or a rendered one pending', () => {
    expect(isPendingSynthesis(AudioCue.parse(narrationCue()))).toBe(false);
    expect(
      isPendingSynthesis(
        AudioCue.parse(
          speechCue({
            blob: { sha256: 'c'.repeat(64), mimeType: 'audio/wav', bytes: 10, durationMs: 2400 },
          }),
        ),
      ),
    ).toBe(false);
    expect(
      isPendingSynthesis(
        AudioCue.parse({
          id: ids.audioCue(),
          track: 'sfx',
          startMs: 0,
          source: { kind: 'effect', key: 'sfx/door/creak' },
          provenance: {},
        }),
      ),
    ).toBe(false);
  });
});

describe('trackForRole', () => {
  it('sends the narrator to narration and everyone else to dialogue', () => {
    expect(trackForRole('narrator')).toBe('narration');
    expect(trackForRole('character')).toBe('dialogue');
  });
});

describe('AudioTimeline', () => {
  it('refuses two cues with the same id', () => {
    const id = ids.audioCue();
    const result = AudioTimeline.safeParse(
      timeline([speechCue({ id }), speechCue({ id, startMs: 8000 })]),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['cues', 1, 'id']);
  });

  it('refuses a cue that starts after the programme ends', () => {
    const result = AudioTimeline.safeParse(timeline([speechCue({ startMs: 60_001 })]));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['cues', 0, 'startMs']);
  });

  it('returns one track in time order, whatever order the cues were written in', () => {
    const parsed = AudioTimeline.parse(
      timeline([
        speechCue({ startMs: 9000 }),
        narrationCue({ startMs: 0 }),
        speechCue({ startMs: 3000 }),
      ]),
    );
    expect(cuesOnTrack(parsed, 'dialogue').map((cue) => cue.startMs)).toEqual([3000, 9000]);
    expect(cuesOnTrack(parsed, 'narration').map((cue) => cue.startMs)).toEqual([0]);
    expect(cuesOnTrack(parsed, 'music')).toEqual([]);
  });

  it('orders two cues at the same instant by id, so the result is stable', () => {
    const parsed = AudioTimeline.parse(
      timeline([speechCue({ startMs: 500 }), speechCue({ startMs: 500 })]),
    );
    const first = cuesOnTrack(parsed, 'dialogue');
    const again = cuesOnTrack(parsed, 'dialogue');
    expect(first.map((cue) => cue.id)).toEqual(again.map((cue) => cue.id));
    expect([...first].map((cue) => cue.id)).toEqual(
      [...first].map((cue) => cue.id).sort((left, right) => left.localeCompare(right)),
    );
  });
});

describe('checkAgainstMarkers', () => {
  const synced = AudioTimeline.parse(
    timeline([speechCue({ startMs: 4200, markerRef: MARKER }), narrationCue({ startMs: 0 })]),
  );

  it('is silent when the two documents agree', () => {
    expect(checkAgainstMarkers(synced, [{ id: MARKER, timeMs: 4200 }])).toEqual([]);
  });

  it('reports a cue pinned to a marker that is not there', () => {
    const issues = checkAgainstMarkers(synced, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('missing-marker');
    expect(issues[0]?.markerTimeMs).toBeNull();
  });

  it('reports a cue that drifted away from its marker', () => {
    // The failure the narrator experiences as "the video does not match".
    const issues = checkAgainstMarkers(synced, [{ id: MARKER, timeMs: 4000 }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('time-mismatch');
    expect(issues[0]?.markerTimeMs).toBe(4000);
    expect(issues[0]?.cueStartMs).toBe(4200);
  });

  it('ignores a cue that was never pinned to anything, because a bed is not a beat', () => {
    const unpinned = AudioTimeline.parse(
      timeline([
        {
          id: ids.audioCue(),
          track: 'ambience',
          startMs: 0,
          source: { kind: 'bed', key: 'ambience/sea/night', mood: 'unresolved' },
          provenance: {},
        },
      ]),
    );
    expect(checkAgainstMarkers(unpinned, [])).toEqual([]);
  });
});
