import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ApiError } from '../api/errors';
import { mountStudio } from '../test/harness';

import AppBadge from './AppBadge.vue';
import AppButton from './AppButton.vue';
import ErrorNotice from './ErrorNotice.vue';

describe('AppButton', () => {
  it('is a real button, focusable and typed', async () => {
    const wrapper = await mountStudio(AppButton, { locale: 'en', props: { variant: 'primary' } });
    expect((wrapper.element as HTMLElement).tagName).toBe('BUTTON');
    expect(wrapper.attributes('type')).toBe('button');
    expect(wrapper.classes()).toContain('rv-button--primary');
  });

  it('forwards unrecognised attributes to the root element', async () => {
    const wrapper = await mountStudio(AppButton, {
      locale: 'en',
      props: { 'aria-label': 'Close the drawer' },
    });
    expect(wrapper.attributes('aria-label')).toBe('Close the drawer');
  });
});

describe('AppBadge', () => {
  it('carries its tone as a class and its long form as a title', async () => {
    const wrapper = await mountStudio(AppBadge, {
      locale: 'en',
      props: { tone: 'warning', title: 'Takes effect after a restart' },
    });
    expect(wrapper.classes()).toContain('rv-badge--warning');
    expect(wrapper.attributes('title')).toBe('Takes effect after a restart');
  });
});

describe('ErrorNotice', () => {
  it('translates the error kind rather than showing the server’s English', async () => {
    const error = new ApiError({
      failure: 'api',
      code: 'budget.exceeded',
      kind: 'budget',
      message: 'run would exceed the ceiling',
    });
    const wrapper = await mountStudio(ErrorNotice, { locale: 'fa', props: { error } });

    expect(wrapper.text()).toContain('سقف هزینه');
    // The English detail is still there, because a provider failure has to be
    // diagnosable, but it is not the headline.
    expect(wrapper.text()).toContain('run would exceed the ceiling');
    expect(wrapper.text()).toContain('budget.exceeded');
  });

  it('names the offending field for a schema mismatch', async () => {
    const parsed = z.strictObject({ count: z.number() }).safeParse({ count: 'x' });
    expect(parsed.success).toBe(false);
    const error = ApiError.schema('/settings', parsed.error!);

    const wrapper = await mountStudio(ErrorNotice, { locale: 'en', props: { error } });
    expect(wrapper.text()).toContain('did not match the data contract');
    expect(wrapper.text()).toContain('Invalid field: count');
  });

  it('says a retry might help only when the error says so', async () => {
    const retryable = await mountStudio(ErrorNotice, {
      locale: 'en',
      props: { error: ApiError.network(new Error('offline')) },
    });
    expect(retryable.text()).toContain('Trying again may work');

    const fatal = await mountStudio(ErrorNotice, {
      locale: 'en',
      props: {
        error: new ApiError({
          failure: 'api',
          code: 'validation.failed',
          kind: 'validation',
          message: 'nope',
        }),
      },
    });
    expect(fatal.text()).not.toContain('Trying again may work');
  });

  it('emits retry when its button is pressed', async () => {
    const wrapper = await mountStudio(ErrorNotice, {
      locale: 'en',
      props: { error: ApiError.network(new Error('offline')) },
    });
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(1);
  });

  it('falls back to a generic message when the failure has no kind', async () => {
    const error = new ApiError({ failure: 'api', code: 'weird', message: 'no kind here' });
    const wrapper = await mountStudio(ErrorNotice, { locale: 'en', props: { error } });
    expect(wrapper.text()).toContain('Something unexpected went wrong');
  });
});
