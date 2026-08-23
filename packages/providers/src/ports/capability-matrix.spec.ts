import { describe, expect, it } from 'vitest';
import { Capability } from '@rv/contracts';
import { ValidationError, isErr, isOk } from '@rv/shared-kernel';

import { CAPABILITY_METHOD, CapabilityMatrix } from './capability-matrix';
import type { ProviderAdapter } from './provider-adapter';
import { declaresCapability } from './provider-adapter';

/** A minimal adapter that really has the methods it claims. */
function fake(
  modelRef: string,
  capabilities: readonly Capability[],
  omitMethods: readonly Capability[] = [],
): ProviderAdapter {
  const adapter: Record<string, unknown> = {
    kind: 'ollama',
    modelRef,
    capabilities,
  };
  for (const capability of capabilities) {
    if (omitMethods.includes(capability)) continue;
    adapter[CAPABILITY_METHOD[capability]] = (): void => undefined;
  }
  return adapter as unknown as ProviderAdapter;
}

describe('CAPABILITY_METHOD', () => {
  it('names a method for every capability in the contract', () => {
    // The one-to-one correspondence between ports and capabilities is what stops the
    // matrix and the port set from drifting apart (architecture §5).
    expect(Object.keys(CAPABILITY_METHOD).sort()).toEqual([...Capability.options].sort());
  });
});

describe('CapabilityMatrix.register', () => {
  it('rejects an adapter that declares no capabilities', () => {
    const matrix = new CapabilityMatrix();
    expect(() => {
      matrix.register(fake('ollama:mute', []));
    }).toThrow(ValidationError);
  });

  it('rejects an adapter that declares a capability it cannot serve', () => {
    const matrix = new CapabilityMatrix();
    expect(() => {
      matrix.register(fake('ollama:liar', ['text-generation'], ['text-generation']));
    }).toThrow(/cannot serve/);
  });

  it('rejects a duplicate model reference', () => {
    const matrix = new CapabilityMatrix();
    matrix.register(fake('ollama:a', ['text-generation']));
    expect(() => {
      matrix.register(fake('ollama:a', ['text-generation']));
    }).toThrow(/already registered/);
  });

  it('registers a whole set at once', () => {
    const matrix = new CapabilityMatrix();
    matrix.registerAll([fake('ollama:a', ['embedding']), fake('ollama:b', ['embedding'])]);
    expect(matrix.adapters()).toHaveLength(2);
  });
});

describe('CapabilityMatrix.resolve', () => {
  it('returns the port for a declared capability', () => {
    const matrix = new CapabilityMatrix();
    matrix.register(fake('ollama:a', ['text-generation', 'embedding']));

    const resolved = matrix.resolve('ollama:a', 'embedding');
    expect(isOk(resolved)).toBe(true);
  });

  it('returns UnsupportedCapabilityError for an undeclared capability', () => {
    const matrix = new CapabilityMatrix();
    matrix.register(fake('ollama:a', ['text-generation']));

    const resolved = matrix.resolve('ollama:a', 'image-edit');
    expect(isErr(resolved)).toBe(true);
    if (isErr(resolved)) {
      expect(resolved.error.kind).toBe('unsupported');
      expect(resolved.error.retryable).toBe(false);
      expect(resolved.error.context.capability).toBe('image-edit');
    }
  });

  it('returns NotFoundError for a model nobody registered', () => {
    const matrix = new CapabilityMatrix();
    const resolved = matrix.resolve('ollama:ghost', 'text-generation');
    expect(isErr(resolved)).toBe(true);
    if (isErr(resolved)) expect(resolved.error.kind).toBe('not-found');
  });
});

describe('CapabilityMatrix queries', () => {
  const matrix = new CapabilityMatrix();
  matrix.register(fake('ollama:a', ['text-generation', 'embedding']));
  matrix.register(fake('ollama:b', ['image-generation']));

  it('lists model refs for a capability in registration order', () => {
    expect(matrix.refsFor('text-generation')).toEqual(['ollama:a']);
    expect(matrix.refsFor('image-generation')).toEqual(['ollama:b']);
    expect(matrix.refsFor('vision-scoring')).toEqual([]);
  });

  it('lists distinct provider kinds for a capability', () => {
    expect(matrix.providersFor('embedding')).toEqual(['ollama']);
  });

  it('reports support without resolving', () => {
    expect(matrix.supports('ollama:a', 'embedding')).toBe(true);
    expect(matrix.supports('ollama:a', 'image-edit')).toBe(false);
    expect(matrix.supports('ollama:missing', 'embedding')).toBe(false);
  });

  it('hands back the raw adapter for inspection', () => {
    expect(matrix.get('ollama:a')?.modelRef).toBe('ollama:a');
    expect(matrix.get('ollama:nope')).toBeUndefined();
  });
});

describe('declaresCapability', () => {
  it('reads the declaration, not the implementation', () => {
    const adapter = fake('ollama:a', ['text-generation']);
    expect(declaresCapability(adapter, 'text-generation')).toBe(true);
    expect(declaresCapability(adapter, 'embedding')).toBe(false);
  });
});
