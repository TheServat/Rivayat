import { FixedClock, instant, millis } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { JobId } from '@rv/contracts';

import { RecordingProgress } from '../ports/progress';
import { ProgressTracker } from './progress-tracker';

const JOB_ID = 'job_0000000000000000000000000A' as JobId;

function tracker(
  framesTotal = 100,
  overrides: Partial<ConstructorParameters<typeof ProgressTracker>[0]> = {},
): {
  tracker: ProgressTracker;
  clock: FixedClock;
  sink: RecordingProgress;
} {
  const clock = new FixedClock(instant(0));
  const sink = new RecordingProgress();
  return {
    clock,
    sink,
    tracker: new ProgressTracker({ jobId: JOB_ID, framesTotal, clock, sink, ...overrides }),
  };
}

describe('ProgressTracker', () => {
  it('counts frames against a denominator known before the first one', () => {
    const { tracker: subject } = tracker(240);
    subject.frameDone();
    expect(subject.snapshot('rendering')).toMatchObject({ framesDone: 1, framesTotal: 240 });
  });

  it('offers no ETA until there is evidence for one', () => {
    // The first frame of a browser render includes the browser starting up;
    // extrapolating from it predicts four hours for a ninety-second clip.
    const { tracker: subject, clock } = tracker();
    subject.frameDone();
    clock.advance(millis(100));
    expect(subject.snapshot('rendering').etaMs).toBeNull();
  });

  it('computes an ETA from measured throughput', () => {
    const { tracker: subject, clock } = tracker(100);
    for (let frame = 0; frame < 5; frame += 1) {
      subject.frameDone();
      clock.advance(millis(100));
    }
    const snapshot = subject.snapshot('rendering');
    // Four intervals of 100 ms across five frames: 10 fps, 95 frames left, 9.5 s.
    expect(snapshot.framesPerSecond).toBeCloseTo(10, 6);
    expect(snapshot.etaMs).toBe(9500);
  });

  it('offers no rate when every frame landed inside one clock tick', () => {
    // "Infinity frames per second" would produce an ETA of zero for a render that has
    // barely started.
    const { tracker: subject } = tracker();
    subject.frameDone();
    subject.frameDone();
    subject.frameDone();
    expect(subject.snapshot('rendering').etaMs).toBeNull();
  });

  it('throttles emission rather than flooding an SSE stream', () => {
    const { tracker: subject, clock, sink } = tracker(100, { minIntervalMs: 1000 });
    subject.emit('preparing');
    for (let frame = 0; frame < 30; frame += 1) {
      subject.frameDone();
      clock.advance(millis(50));
    }
    // 30 frames over 1.5 s: the preparing tick plus one throttled tick.
    expect(sink.ticks.length).toBeLessThan(5);
    expect(sink.ticks.length).toBeGreaterThan(1);
  });

  it('emits at least once per second at a slow frame rate', () => {
    const { tracker: subject, clock, sink } = tracker(10, { minIntervalMs: 1000 });
    for (let frame = 0; frame < 5; frame += 1) {
      clock.advance(millis(1200));
      subject.frameDone();
    }
    expect(sink.ticks).toHaveLength(5);
  });

  it('does not let the bar sit at 100 % through the encode', () => {
    // `fraction` is deliberately not framesDone/framesTotal: encoding and reframing
    // take real time after the last frame is drawn.
    const { tracker: subject } = tracker(10);
    for (let frame = 0; frame < 10; frame += 1) subject.frameDone();
    expect(subject.snapshot('rendering').fraction).toBeCloseTo(0.8, 6);
    expect(subject.snapshot('encoding').fraction).toBeGreaterThan(0.8);
    expect(subject.snapshot('finalising').fraction).toBe(1);
  });

  it('never reports more frames done than there are', () => {
    const { tracker: subject } = tracker(2);
    for (let frame = 0; frame < 5; frame += 1) subject.frameDone();
    expect(subject.snapshot('rendering').framesDone).toBe(2);
    expect(subject.framesDone).toBe(5);
  });

  it('carries the format being encoded and an optional message', () => {
    const { tracker: subject, sink } = tracker();
    subject.emit('encoding', 'reels-9x16', 'transcoding');
    expect(sink.ticks[0]).toMatchObject({
      phase: 'encoding',
      currentFormat: 'reels-9x16',
      message: 'transcoding',
    });
  });

  it('omits the message field entirely when there is none', () => {
    const { tracker: subject } = tracker();
    expect('message' in subject.snapshot('rendering')).toBe(false);
  });

  it('reports a full fraction for a job with no frames at all', () => {
    const { tracker: subject } = tracker(0);
    expect(subject.snapshot('rendering').fraction).toBeCloseTo(0.8, 6);
  });
});
