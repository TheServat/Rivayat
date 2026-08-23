import { SETTINGS_REGISTRY, settingFor } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import { settingValidator } from './setting-validator';

describe('settingValidator', () => {
  /**
   * The property that replaces ten hand-written cases.
   *
   * Every declaration in the registry must be validatable, and the value the validator
   * accepts must be the value the declaration accepts - because they are now the same
   * object. A per-control-kind table would only prove that the reconstruction the
   * function no longer performs still worked.
   */
  it('returns the declaration’s own schema for every key in the registry', () => {
    for (const descriptor of SETTINGS_REGISTRY) {
      expect(settingValidator(descriptor.key), descriptor.key).toBe(descriptor.schema);
    }
  });

  it('accepts every declared default, which is the value a fresh install runs on', () => {
    for (const descriptor of SETTINGS_REGISTRY) {
      const result = settingValidator(descriptor.key).safeParse(descriptor.default);
      expect(result.success, descriptor.key).toBe(true);
    }
  });

  it('accepts every option a closed-choice control offers', () => {
    // A select whose declared options its own schema rejects is a form that cannot be
    // used: every choice is a validation error.
    const closed = SETTINGS_REGISTRY.filter((descriptor) =>
      ['select', 'multi-select'].includes(descriptor.control.kind),
    );
    expect(closed.length).toBeGreaterThan(0);
    for (const descriptor of closed) {
      const schema = settingValidator(descriptor.key);
      for (const option of descriptor.options ?? []) {
        const candidate =
          descriptor.control.kind === 'multi-select' ? [option.value] : option.value;
        expect(
          schema.safeParse(candidate).success,
          `${descriptor.key}=${String(option.value)}`,
        ).toBe(true);
      }
    }
  });
});

describe('the bounds the registry actually declares', () => {
  it('enforces the slider range on render.concurrency', () => {
    const schema = settingValidator('render.concurrency');
    expect(schema.safeParse(8).success).toBe(true);
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(64).success).toBe(false);
    expect(schema.safeParse(4.5).success).toBe(false);
  });

  it('requires a real URL for provider.ollama.host', () => {
    const schema = settingValidator('provider.ollama.host');
    expect(schema.safeParse('http://127.0.0.1:11434').success).toBe(true);
    expect(schema.safeParse('127.0.0.1:11434').success).toBe(false);
  });

  it('accepts only declared lanes for image.lane', () => {
    const schema = settingValidator('image.lane');
    expect(schema.safeParse('colab').success).toBe(true);
    expect(schema.safeParse('pollinations').success).toBe(false);
  });

  it('treats a null budget ceiling as "no ceiling" and refuses a negative one', () => {
    const schema = settingValidator('budget.perRunNanoUsd');
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(2_500_000_000).success).toBe(true);
    expect(schema.safeParse(-1).success).toBe(false);
  });

  it('requires at least one delivery format', () => {
    const schema = settingValidator('delivery.formats');
    expect(schema.safeParse(['yt-1080p']).success).toBe(true);
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(['not-a-format']).success).toBe(false);
  });

  it('accepts a provider-qualified reference or null for a stage model', () => {
    const schema = settingValidator('model.stage.story');
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse('ollama:qwen3.5:latest').success).toBe(true);
    expect(schema.safeParse('qwen3.5:latest').success).toBe(false);
  });

  it('accepts a bare provider-native id for a provider’s own role model', () => {
    // The same control kind, a different spelling: the slot is already scoped to one
    // provider, so there is nothing for the reference to qualify.
    const schema = settingValidator('provider.ollama.textModel');
    expect(schema.safeParse('llama3.2:latest').success).toBe(true);
    expect(schema.safeParse('').success).toBe(false);
  });
});

describe('a key the registry does not declare', () => {
  /**
   * Accepting anything is the deliberate answer.
   *
   * A form cannot validate what the registry does not declare, and refusing outright
   * would break a studio one deploy behind an API that has just added a setting. The
   * server still refuses an unknown key, so the failure surfaces as a rejected save
   * naming the field - not as a stored value nothing understands.
   */
  it('accepts anything rather than refusing a setting it has not heard of', () => {
    const schema = settingValidator('provider.newthing.token');
    expect(schema.safeParse('anything').success).toBe(true);
    expect(schema.safeParse({ nested: [1, 2] }).success).toBe(true);
  });

  it('does not confuse a near-miss with the real key', () => {
    expect(settingValidator('image.lanes')).not.toBe(settingFor('image.lane').schema);
  });
});
