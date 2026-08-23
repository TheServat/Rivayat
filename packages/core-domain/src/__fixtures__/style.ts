/**
 * A parsed, valid `StyleBible` for the locking tests.
 *
 * Parsed rather than cast: `computeStyleChecksum` runs `StyleCheckpointInput.parse`,
 * which fills defaults, so a fixture that skipped parsing would hash differently from
 * anything the real pipeline produces.
 */

import { FixedClock, IdGenerator, instant } from '@rv/shared-kernel';
import { Ids, StyleBible, type StyleBibleId } from '@rv/contracts';

const ids = new Ids(new IdGenerator(new FixedClock(instant(1_724_400_000_000)), fixedBytes()));

function fixedBytes(): (size: number) => Uint8Array {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, i) => (counter * 5 + i * 23) & 0xff);
  };
}

const STYLE_ID = ids.styleBible();
export const otherStyleId: StyleBibleId = ids.styleBible();

export function styleBibleFixture(): StyleBible {
  return StyleBible.parse({
    id: STYLE_ID,
    name: 'Paper Grove',
    version: 1,
    origin: 'preset',
    visual: {
      medium: 'paper-cutout',
      palette: {
        colors: [
          { name: 'moss', hex: '#4a6b3f', role: 'primary' },
          { name: 'bark', hex: '#5a4632', role: 'secondary' },
          { name: 'sky', hex: '#cfe3ef', role: 'background' },
        ],
        harmony: 'earthy',
      },
      shape: {
        silhouetteRule: 'Readable as a solid black shape at 64px.',
      },
      negative: ['photorealism', 'text'],
    },
    motion: {
      stepMode: 'on-2s',
      easings: [{ name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } }],
      defaultEasing: 'ease-in-out',
    },
    prompts: {
      positive: 'layered paper cutout, matte textured paper, soft drop shadow',
      negative: 'photorealistic, 3d render, text, watermark',
      bySubject: { foliage: 'torn paper edges on every leaf cluster' },
    },
    seed: 12345,
    checksum: '0'.repeat(64),
    createdAt: '2026-08-01T00:00:00.000Z',
  });
}
