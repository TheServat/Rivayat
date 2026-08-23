import { describe, expect, it } from 'vitest';

import {
  countFrames,
  isResumable,
  lastContiguousFrame,
  normaliseRanges,
  rangesContain,
  subtractRanges,
  toRenderCheckpoint,
  withFrame,
} from './checkpoint';

describe('normaliseRanges', () => {
  it('merges touching ranges, so a frame-by-frame checkpoint stays small', () => {
    // Without this, 2,700 single-frame ranges would exceed the schema's 4,096 cap and
    // the checkpoint would stop being storable halfway through a long render.
    expect(
      normaliseRanges([
        { from: 0, to: 30 },
        { from: 30, to: 60 },
      ]),
    ).toEqual([{ from: 0, to: 60 }]);
  });

  it('merges overlapping ranges and sorts them', () => {
    expect(
      normaliseRanges([
        { from: 50, to: 70 },
        { from: 0, to: 20 },
        { from: 10, to: 55 },
      ]),
    ).toEqual([{ from: 0, to: 70 }]);
  });

  it('keeps a genuine gap', () => {
    expect(
      normaliseRanges([
        { from: 0, to: 10 },
        { from: 20, to: 30 },
      ]),
    ).toEqual([
      { from: 0, to: 10 },
      { from: 20, to: 30 },
    ]);
  });

  it('drops empty ranges', () => {
    expect(
      normaliseRanges([
        { from: 5, to: 5 },
        { from: 7, to: 6 },
      ]),
    ).toEqual([]);
  });

  it('keeps a range wholly inside another from shrinking it', () => {
    expect(
      normaliseRanges([
        { from: 0, to: 100 },
        { from: 10, to: 20 },
      ]),
    ).toEqual([{ from: 0, to: 100 }]);
  });
});

describe('subtractRanges', () => {
  it('is the whole target when nothing is done', () => {
    expect(subtractRanges({ from: 0, to: 100 }, [])).toEqual([{ from: 0, to: 100 }]);
  });

  it('is what resume means: the target minus what is finished', () => {
    expect(subtractRanges({ from: 0, to: 100 }, [{ from: 0, to: 30 }])).toEqual([
      { from: 30, to: 100 },
    ]);
  });

  it('leaves the holes a sharded job produces', () => {
    expect(
      subtractRanges({ from: 0, to: 100 }, [
        { from: 0, to: 25 },
        { from: 50, to: 75 },
      ]),
    ).toEqual([
      { from: 25, to: 50 },
      { from: 75, to: 100 },
    ]);
  });

  it('is empty when the target is fully covered', () => {
    expect(subtractRanges({ from: 10, to: 20 }, [{ from: 0, to: 100 }])).toEqual([]);
  });

  it('ignores completed ranges outside the target', () => {
    expect(
      subtractRanges({ from: 40, to: 60 }, [
        { from: 0, to: 10 },
        { from: 90, to: 100 },
      ]),
    ).toEqual([{ from: 40, to: 60 }]);
  });

  it('clips a completed range that overhangs the target', () => {
    expect(subtractRanges({ from: 0, to: 50 }, [{ from: 40, to: 500 }])).toEqual([
      { from: 0, to: 40 },
    ]);
  });
});

describe('withFrame', () => {
  it('grows a run rather than adding a range per frame', () => {
    let ranges = normaliseRanges([]);
    for (let frame = 0; frame < 5; frame += 1) ranges = withFrame(ranges, frame);
    expect(ranges).toEqual([{ from: 0, to: 5 }]);
  });

  it('starts a new run across a gap', () => {
    expect(withFrame([{ from: 0, to: 5 }], 9)).toEqual([
      { from: 0, to: 5 },
      { from: 9, to: 10 },
    ]);
  });
});

describe('counting and membership', () => {
  it('counts the frames in a set of ranges', () => {
    expect(
      countFrames([
        { from: 0, to: 10 },
        { from: 5, to: 20 },
      ]),
    ).toBe(20);
  });

  it('tests membership half-open', () => {
    expect(rangesContain([{ from: 0, to: 10 }], 9)).toBe(true);
    expect(rangesContain([{ from: 0, to: 10 }], 10)).toBe(false);
  });
});

describe('lastContiguousFrame', () => {
  it('is the highest frame with nothing missing below it', () => {
    expect(lastContiguousFrame([{ from: 0, to: 30 }])).toBe(29);
  });

  it('is null for a shard that does not start at zero', () => {
    // "Highest contiguous frame finished" is not "highest frame finished": a shard that
    // owns [100, 200) has finished 199 and is contiguously complete up to nothing.
    expect(lastContiguousFrame([{ from: 100, to: 200 }])).toBeNull();
    expect(lastContiguousFrame([])).toBeNull();
  });
});

describe('toRenderCheckpoint', () => {
  it('maps the storage shape onto the contract shape', () => {
    const checkpoint = toRenderCheckpoint({
      jobId: 'job_1',
      completedRanges: [
        { from: 0, to: 10 },
        { from: 10, to: 20 },
      ],
      irHash: 'abc',
      lastFrameHash: null,
      updatedAtIso: '2026-08-23T00:00:00.000Z',
    });
    expect(checkpoint).toEqual({
      completedRanges: [{ from: 0, to: 20 }],
      lastCompletedFrame: 19,
      lastFrameHash: null,
      updatedAt: '2026-08-23T00:00:00.000Z',
    });
  });
});

describe('isResumable', () => {
  const record = {
    jobId: 'job_1',
    completedRanges: [],
    irHash: 'abc',
    lastFrameHash: null,
    updatedAtIso: '',
  };

  it('resumes against the IR the frames were drawn from', () => {
    expect(isResumable(record, 'abc')).toBe(true);
  });

  it('refuses when the IR changed underneath the job', () => {
    // Continuing would splice two different films together.
    expect(isResumable(record, 'def')).toBe(false);
  });

  it('refuses when there is no checkpoint at all', () => {
    expect(isResumable(null, 'abc')).toBe(false);
  });
});
