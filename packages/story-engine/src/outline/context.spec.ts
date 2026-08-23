import { describe, expect, it } from 'vitest';

import { outlineContext, styleBibleFixture } from '../__fixtures__/builders';
import { brief } from '../__fixtures__/builders';
import { outlineContextFromBible, renderOutlineContext } from './context';

const IMPORTED = brief('series-bible') as Extract<
  ReturnType<typeof brief>,
  { kind: 'series-bible' }
>;

describe('outlineContextFromBible', () => {
  it('reads the always-included set straight off the bible', () => {
    const context = outlineContextFromBible(IMPORTED.bible);

    expect(context.seriesTitle).toBe('The Keeper and the Tide');
    expect(context.premise).toContain('lighthouse keeper');
    expect(context.themes).toEqual(['inherited guilt']);
    expect(context.genre).toEqual(['folk horror']);
    expect(context.episodeDurationMs).toBe(420_000);
    expect(context.canonPolicy.retcon).toBe('reveal-only');
  });

  it('marks an inviolable law as inviolable, because that changes what a scene may do', () => {
    const [rule] = outlineContextFromBible(IMPORTED.bible).worldRules;
    expect(rule).toContain('[metaphysics, inviolable]');
    expect(rule).toContain('The dead do not speak.');
  });

  it('does not mark a breakable law as inviolable', () => {
    const bendable = {
      ...IMPORTED.bible,
      rulesOfTheWorld: [
        {
          scope: 'magic' as const,
          statement: 'A name spoken twice binds its owner.',
          inviolable: false,
          consequenceIfBroken: 'The speaker loses their own name.',
        },
      ],
    };
    expect(outlineContextFromBible(bendable).worldRules[0]).toContain('[magic]');
  });
});

describe('renderOutlineContext', () => {
  it('opens every outline prompt with the premise and the laws', () => {
    const rendered = renderOutlineContext(outlineContext());
    expect(rendered).toContain('Series: The Keeper and the Tide');
    expect(rendered).toContain('## Premise');
    expect(rendered).toContain('Laws of this world');
    expect(rendered).toContain('Retcons: reveal-only');
    expect(rendered).toContain('about 7.0 minutes');
  });

  it('omits the runtime line when the shape is not decided yet', () => {
    const { episodeDurationMs: _drop, ...withoutDuration } = outlineContext();
    expect(renderOutlineContext(withoutDuration)).not.toContain('minutes');
  });

  it('says so when the world has no declared laws', () => {
    expect(renderOutlineContext(outlineContext({ worldRules: [] }))).toContain('none declared');
  });

  it('reads the same fields whether it came from a bible or was built by hand', () => {
    const fromBible = outlineContextFromBible(IMPORTED.bible);
    expect(renderOutlineContext(fromBible)).toContain(fromBible.premise);
    // The style bible is a separate document and contributes nothing here.
    expect(renderOutlineContext(fromBible)).not.toContain(styleBibleFixture().name);
  });
});
