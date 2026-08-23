import { describe, expect, it } from 'vitest';
import { sha256 } from '@rv/shared-kernel';

import {
  binaryArtifact,
  frameCountOf,
  jsonArtifact,
  sampleFrames,
  slugifyName,
  totalBytes,
} from './port';
import { easedMoveIr, windIr } from './__fixtures__/ir';

describe('artifacts', () => {
  it('hashes its own bytes, so two identical exports are recognisably identical', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const artifact = binaryArtifact('a.png', 'image/png', bytes);
    expect(artifact.sha256).toBe(sha256(bytes));
  });

  it('writes JSON as readable UTF-8', () => {
    const artifact = jsonArtifact('meta.json', { a: 1, persian: 'دِرَخت' });
    const text = new TextDecoder().decode(artifact.bytes);
    expect(JSON.parse(text)).toEqual({ a: 1, persian: 'دِرَخت' });
    expect(text).toContain('\n');
    expect(artifact.mediaType).toBe('application/json');
  });

  it('sums bytes across artifacts', () => {
    expect(
      totalBytes([
        binaryArtifact('a', 'x', new Uint8Array(3)),
        binaryArtifact('b', 'x', new Uint8Array(5)),
      ]),
    ).toBe(8);
  });
});

describe('slugifyName', () => {
  it('makes a label safe to use as a path', () => {
    expect(slugifyName('Wind Study')).toBe('wind-study');
    expect(slugifyName('  A/B: "quoted"  ')).toBe('a-b-quoted');
  });

  it('falls back rather than producing an empty file name', () => {
    expect(slugifyName('دِرَخت')).toBe('animation');
    expect(slugifyName('...', 'armature')).toBe('armature');
  });
});

describe('frameCountOf', () => {
  it('rounds the duration onto the frame grid', () => {
    expect(frameCountOf(windIr(3000))).toBe(90);
    expect(frameCountOf(easedMoveIr())).toBe(60);
  });

  it('never returns zero, so a sub-frame clip still has one frame', () => {
    expect(frameCountOf(windIr(1))).toBe(1);
  });
});

describe('sampleFrames', () => {
  it('samples the whole grid at stride 1, inclusive of the end', () => {
    expect(sampleFrames(4, 1)).toEqual([0, 1, 2, 3, 4]);
  });

  it('always pins the final frame even when the stride steps over it', () => {
    expect(sampleFrames(10, 4)).toEqual([0, 4, 8, 10]);
    expect(sampleFrames(1, 5)).toEqual([0, 1]);
  });

  it('does not duplicate the final frame when the stride lands on it', () => {
    expect(sampleFrames(8, 4)).toEqual([0, 4, 8]);
  });

  it('treats a fractional or zero stride as 1 rather than looping forever', () => {
    expect(sampleFrames(3, 0.5)).toEqual([0, 1, 2, 3]);
  });
});
