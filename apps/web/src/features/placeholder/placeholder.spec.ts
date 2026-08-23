import { describe, expect, it } from 'vitest';

import { flush, mountStudio } from '../../test/harness';

import NotFoundView from './NotFoundView.vue';
import PlaceholderView from './PlaceholderView.vue';
import { PLACEHOLDER_TOPICS } from './topics';

describe('PlaceholderView', () => {
  it('says plainly that the screen does not exist yet', async () => {
    const wrapper = await mountStudio(PlaceholderView, {
      locale: 'en',
      props: { topic: 'styleLab', stories: ['RV-204'] },
    });

    expect(wrapper.text()).toContain('Not built yet');
    expect(wrapper.text()).toContain('has not been implemented');
  });

  it('describes what the screen will hold, in both locales, for every topic', async () => {
    for (const topic of PLACEHOLDER_TOPICS) {
      for (const locale of ['fa', 'en'] as const) {
        const wrapper = await mountStudio(PlaceholderView, {
          locale,
          props: { topic, stories: ['RV-000'] },
        });
        // Long enough to be a real description of scope rather than a stub heading.
        expect(wrapper.text().length, `${topic}/${locale}`).toBeGreaterThan(80);
        expect(wrapper.text(), `${topic}/${locale}`).toContain('RV-000');
      }
    }
  });

  it('renders no controls, so nothing looks operable', async () => {
    const wrapper = await mountStudio(PlaceholderView, {
      locale: 'en',
      props: { topic: 'assets', stories: ['RV-208'] },
    });
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(wrapper.findAll('input')).toHaveLength(0);
  });
});

describe('NotFoundView', () => {
  it('explains the address is unknown and offers a way back', async () => {
    const wrapper = await mountStudio(NotFoundView, { locale: 'en', path: '/nowhere' });
    await flush();

    expect(wrapper.text()).toContain('Page not found');
    expect(wrapper.find('a').attributes('href')).toBe('/projects');
  });
});
