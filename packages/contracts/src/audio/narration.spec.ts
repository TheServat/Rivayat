/**
 * The narrator's page.
 *
 * The acceptance criterion the owner gave is not a shape - it is "if they have to decode
 * it while reading, it has failed". That cannot be asserted directly, so it is asserted
 * as the properties it decomposes into: no markup on the page, the timing present once
 * per passage, breaths as lines, silence written out, Persian digits. The last test
 * prints a whole page into the snapshot so a human can read it and judge the thing the
 * assertions cannot.
 */

import { describe, expect, it } from 'vitest';

import { Ids } from '../primitives/ids';
import { PLAIN_DIRECTION } from './emotion';
import {
  ASSUMED_PERSIAN_CHARS_PER_SECOND,
  DEFAULT_BREATH_CHARS,
  formatClock,
  formatSeconds,
  renderNarrationSheet,
  splitBreathGroups,
  toNarrationScript,
  toPersianDigits,
} from './narration';
import { AudioCue, AudioTimeline } from './timeline';

const ids = new Ids();
const NARRATOR = ids.entity();
const MAHTAB = ids.entity();

function narration(
  text: string,
  startMs: number,
  durationMs: number,
  direction = PLAIN_DIRECTION,
): Record<string, unknown> {
  return {
    id: ids.audioCue(),
    track: 'narration',
    startMs,
    durationMs,
    source: {
      kind: 'speech',
      speakerRef: NARRATOR,
      performer: 'human',
      text,
      language: 'fa',
      direction,
    },
    provenance: {},
  };
}

function dialogue(text: string, startMs: number): Record<string, unknown> {
  return {
    id: ids.audioCue(),
    track: 'dialogue',
    startMs,
    durationMs: 1800,
    source: {
      kind: 'speech',
      speakerRef: MAHTAB,
      performer: 'synthetic',
      text,
      language: 'fa',
      direction: PLAIN_DIRECTION,
    },
    provenance: {},
  };
}

function timeline(cues: readonly unknown[], durationMs = 60_000): AudioTimeline {
  return AudioTimeline.parse({
    animationRef: 'anm_lighthouse_01',
    durationMs,
    language: 'fa',
    cues,
  });
}

describe('splitBreathGroups', () => {
  it('breaks at the end of a thought, in Persian punctuation and in Latin', () => {
    expect(splitBreathGroups('شب شد. فانوس روشن است.')).toEqual(['شب شد.', 'فانوس روشن است.']);
    expect(splitBreathGroups('کجاست؟ نمی‌داند!')).toEqual(['کجاست؟', 'نمی‌داند!']);
  });

  it('leaves a short sentence whole, comma and all', () => {
    // A break that is not needed reads as a pause the writer never wrote.
    expect(splitBreathGroups('شب که شد، فانوس را روشن کرد.')).toEqual([
      'شب که شد، فانوس را روشن کرد.',
    ]);
  });

  it('falls back to the clause only when a sentence is too long to take in', () => {
    const long =
      'شب که می‌شود و دریا آرام می‌گیرد، مهتاب پله‌ها را یکی‌یکی بالا می‌رود، و فانوس را روشن می‌کند.';
    const groups = splitBreathGroups(long);
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) expect(group.length).toBeLessThanOrEqual(DEFAULT_BREATH_CHARS + 8);
  });

  it('falls back to a space only when there is no punctuation left to use', () => {
    const groups = splitBreathGroups(
      'a'.repeat(20) + ' ' + 'b'.repeat(20) + ' ' + 'c'.repeat(20),
      25,
    );
    expect(groups.length).toBeGreaterThan(1);
  });

  it('hands back an unbreakable run rather than chopping a word in half', () => {
    const unbreakable = 'x'.repeat(200);
    expect(splitBreathGroups(unbreakable, 40)).toEqual([unbreakable]);
  });

  it('treats a written line break as a breath the writer asked for', () => {
    expect(splitBreathGroups('شب شد\n\nفانوس روشن است')).toEqual(['شب شد', 'فانوس روشن است']);
  });

  it('always returns at least one group, even for something with nothing to break', () => {
    expect(splitBreathGroups('.')).toEqual(['.']);
    expect(splitBreathGroups('   ')).toEqual(['']);
  });
});

describe('Persian numerals and clocks', () => {
  it('converts digits, and leaves everything else alone', () => {
    expect(toPersianDigits('0:08')).toBe('۰:۰۸');
    expect(toPersianDigits('بند ۳')).toBe('بند ۳');
  });

  it('reads a time the way a person glancing at it would', () => {
    expect(formatClock(0)).toBe('۰:۰۰');
    expect(formatClock(8_400)).toBe('۰:۰۸');
    expect(formatClock(252_000)).toBe('۴:۱۲');
  });

  it('reads a duration as a count of seconds, not as a timecode', () => {
    expect(formatSeconds(8_400)).toBe('۸ ثانیه');
  });
});

describe('toNarrationScript', () => {
  const script = toNarrationScript(
    timeline([
      narration('شب که می‌شود، فانوس را روشن می‌کند.', 0, 4000),
      dialogue('کسی آنجا نیست.', 5000),
      narration('دریا اسمی را می‌گوید که هرگز نشنیده است.', 9000, 5000, {
        ...PLAIN_DIRECTION,
        emotion: 'awe',
        pace: 'slow',
      }),
    ]),
    { title: 'فانوس', episodeLabel: 'قسمت ۱' },
  );

  it('reads only what a person has to read', () => {
    // The narrator/character split, as a filter. A dialogue line on the page would be a
    // line the owner reads that the episode already contains.
    expect(script.passages).toHaveLength(2);
    expect(script.passages.map((passage) => passage.index)).toEqual([1, 2]);
  });

  it('takes its timings from the timeline, so the two cannot disagree', () => {
    expect(script.passages[0]?.startMs).toBe(0);
    expect(script.passages[0]?.durationMs).toBe(4000);
    expect(script.passages[1]?.startMs).toBe(9000);
    expect(script.totalDurationMs).toBe(60_000);
    expect(script.animationRef).toBe('anm_lighthouse_01');
  });

  it('measures the silence between passages, because a rest is something to perform', () => {
    expect(script.passages[0]?.restBeforeMs).toBe(0);
    // The first passage ends at 4000, the second starts at 9000.
    expect(script.passages[1]?.restBeforeMs).toBe(5000);
  });

  it('carries the direction through for the page to print', () => {
    expect(script.passages[1]?.direction.emotion).toBe('awe');
  });

  it('breaks each passage into breaths before it ever reaches the page', () => {
    expect(script.passages[0]?.breaths.length).toBeGreaterThanOrEqual(1);
  });

  it('warns when the words plainly will not fit the window', () => {
    const tight = toNarrationScript(
      timeline([narration('این یک بند بسیار طولانی است که در این زمان جا نمی‌شود.', 0, 500)]),
      { title: 'x', episodeLabel: 'y' },
    );
    expect(tight.passages[0]?.fitsWindow).toBe(false);
  });

  it('does not cry wolf on a passage that comfortably fits', () => {
    expect(script.passages[0]?.fitsWindow).toBe(true);
  });

  it('takes the reading rate as an option, because the shipped one is a working figure', () => {
    expect(ASSUMED_PERSIAN_CHARS_PER_SECOND).toBeGreaterThan(0);
    const strict = toNarrationScript(
      timeline([narration('شب که می‌شود، فانوس را روشن می‌کند.', 0, 4000)]),
      { title: 'x', episodeLabel: 'y', charsPerSecond: 2 },
    );
    expect(strict.passages[0]?.fitsWindow).toBe(false);
  });

  it('accepts a narrower breath width for a reader who wants shorter lines', () => {
    const narrow = toNarrationScript(
      timeline([narration('شب که می‌شود، فانوس را روشن می‌کند.', 0, 4000)]),
      { title: 'x', episodeLabel: 'y', maxBreathChars: 12 },
    );
    expect(narrow.passages[0]?.breaths.length).toBeGreaterThan(1);
  });

  it('prints what is on screen when the compiler knew, and nothing when it did not', () => {
    const cue = narration('شب شد.', 0, 3000);
    const withNote = toNarrationScript(timeline([cue]), {
      title: 'x',
      episodeLabel: 'y',
      onScreen: { [String(cue.id)]: 'پله‌های برج' },
    });
    expect(withNote.passages[0]?.onScreen).toBe('پله‌های برج');
    expect(script.passages[0]).not.toHaveProperty('onScreen');
  });

  it('skips a synthetic narration cue, which belongs to the episode and not to the reader', () => {
    const machineNarrated = timeline([
      {
        ...narration('این را ماشین می‌خواند.', 0, 3000),
        source: {
          kind: 'speech',
          speakerRef: NARRATOR,
          performer: 'synthetic',
          text: 'این را ماشین می‌خواند.',
          language: 'fa',
          direction: PLAIN_DIRECTION,
        },
      },
    ]);
    expect(
      toNarrationScript(machineNarrated, { title: 'x', episodeLabel: 'y' }).passages,
    ).toHaveLength(0);
  });

  it('skips a narration cue with no window, rather than asking for a read to nothing', () => {
    // `AudioCue` already refuses this, so the branch is belt and braces - and it is the
    // kind that costs one comparison and protects the page from a future relaxation.
    const parsed = AudioCue.parse(narration('بی‌زمان.', 0, 1000));
    const windowless: AudioTimeline = {
      ...timeline([]),
      cues: [{ ...parsed, durationMs: null }],
    };
    expect(toNarrationScript(windowless, { title: 'x', episodeLabel: 'y' }).passages).toHaveLength(
      0,
    );
  });

  it('ignores an effect cue that somehow reached the narration track', () => {
    // Unreachable through the schema, which is the point: the filter does not depend on
    // the refinement holding, so a future relaxation cannot put a door creak on the page.
    const effect = AudioCue.parse({
      id: ids.audioCue(),
      track: 'sfx',
      startMs: 0,
      durationMs: 100,
      source: { kind: 'effect', key: 'sfx/door/creak' },
      provenance: {},
    });
    const script2 = toNarrationScript(
      { ...timeline([]), cues: [{ ...effect, track: 'narration' }] },
      { title: 'x', episodeLabel: 'y' },
    );
    expect(script2.passages).toHaveLength(0);
  });
});

describe('renderNarrationSheet', () => {
  const sheet = renderNarrationSheet(
    toNarrationScript(
      timeline(
        [
          narration('شب که می‌شود، فانوس را روشن می‌کند.', 0, 6000),
          narration('دریا اسمی را می‌گوید\nکه هرگز نشنیده است.', 12_000, 7000, {
            emotion: 'awe',
            intensity: 0.7,
            pace: 'slow',
            volume: 'low',
            stance: 'plain',
            note: 'روی کلمهٔ آخر رها کن.',
          }),
        ],
        25_000,
      ),
      { title: 'فانوس', episodeLabel: 'قسمت ۱' },
    ),
  );

  it('puts nothing on the page that is markup', () => {
    // No angle brackets, no square brackets, no asterisks, no underscores: nothing the
    // reader has to skip with their eyes while speaking with their mouth.
    expect(sheet).not.toMatch(/[<>[\]*_{}]/u);
  });

  it('uses Persian digits everywhere, so the eye never switches script', () => {
    expect(sheet).not.toMatch(/[0-9]/u);
  });

  it('states each passage once, as a window and a length', () => {
    expect(sheet).toContain('۰:۰۰ تا ۰:۰۶');
    expect(sheet).toContain('۶ ثانیه');
  });

  it('writes the silence out as something to do', () => {
    expect(sheet).toContain('۶ ثانیه سکوت');
  });

  it('prints the delivery as Persian words, on their own line, only when there is one', () => {
    expect(sheet).toContain('شگفتی، آهسته، آرام');
    // The first passage is neutral, measured, normal and plain: the page says nothing,
    // because a direction printed above every passage trains the reader to skip it.
    const firstBlock = sheet.slice(sheet.indexOf('۱ ·'), sheet.indexOf('۲ ·'));
    expect(firstBlock).not.toContain('خنثی');
  });

  it('puts each breath on its own line, which is the only pause instruction there is', () => {
    expect(sheet).toContain('  دریا اسمی را می‌گوید');
    expect(sheet).toContain('  که هرگز نشنیده است.');
  });

  it('passes the writer note through verbatim, because it is for the reader', () => {
    expect(sheet).toContain('روی کلمهٔ آخر رها کن.');
  });

  it('warns on the page when a passage will not fit its window', () => {
    const tight = renderNarrationSheet(
      toNarrationScript(
        timeline([narration('این یک بند بسیار طولانی است که در این زمان جا نمی‌شود.', 0, 500)]),
        { title: 'x', episodeLabel: 'y' },
      ),
    );
    expect(tight).toContain('برای این زمان بلند است');
  });

  it('reads as a page a person could perform from', () => {
    expect(sheet).toMatchInlineSnapshot(`
      "فانوس
      قسمت ۱ · ۰:۲۵ · ۲ بند

      ────────────────────────────────────────
      ۱ · ۰:۰۰ تا ۰:۰۶ · ۶ ثانیه

        شب که می‌شود، فانوس را روشن می‌کند.

      ────────────────────────────────────────
      ۶ ثانیه سکوت

      ۲ · ۰:۱۲ تا ۰:۱۹ · ۷ ثانیه
      شگفتی، آهسته، آرام

        دریا اسمی را می‌گوید
        که هرگز نشنیده است.

      روی کلمهٔ آخر رها کن.

      ────────────────────────────────────────
      "
    `);
  });

  it('prints what is on screen, so the reader knows what they are reading to', () => {
    const cue = narration('شب شد.', 0, 3000);
    const withNote = renderNarrationSheet(
      toNarrationScript(timeline([cue]), {
        title: 'x',
        episodeLabel: 'y',
        onScreen: { [String(cue.id)]: 'پله‌های برج' },
      }),
    );
    expect(withNote).toContain('روی تصویر: پله‌های برج');
  });

  it('names a stance on the page, because it changes how the line is read', () => {
    const held = renderNarrationSheet(
      toNarrationScript(
        timeline([
          narration('چیزی نیست.', 0, 3000, {
            ...PLAIN_DIRECTION,
            stance: 'concealing',
          }),
        ]),
        { title: 'x', episodeLabel: 'y' },
      ),
    );
    expect(held).toContain('پنهان‌کار');
  });

  it('renders an empty script without pretending there is a passage', () => {
    const empty = renderNarrationSheet(
      toNarrationScript(timeline([]), { title: 'x', episodeLabel: 'y' }),
    );
    expect(empty).toContain('۰ بند');
  });
});
