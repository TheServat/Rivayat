import { describe, expect, it } from 'vitest';
import { ClipId, NodeId } from '@rv/contracts';

import { contentId } from './content-ids';

describe('contentId', () => {
  it('produces an id the contracts accept', () => {
    expect(NodeId.safeParse(contentId('nod', 'tree:sway:root')).success).toBe(true);
    expect(ClipId.safeParse(contentId('clp', 'tree:sway')).success).toBe(true);
  });

  it('is a pure function of the seed, which is what makes clip sharing work', () => {
    expect(contentId('nod', 'a')).toBe(contentId('nod', 'a'));
    expect(contentId('nod', 'a')).not.toBe(contentId('nod', 'b'));
  });

  it('keeps the prefix, so an id still says what it identifies', () => {
    expect(contentId('bhv', 'x').startsWith('bhv_')).toBe(true);
  });
});
