import { describe, expect, it } from 'vitest';

import { nanoUsd } from '@rv/shared-kernel';

import { EXIT } from './exit';
import { BufferIo } from './io';
import { guardSpend, parseLane } from './spend';

describe('parseLane', () => {
  it('defaults to free, because free is the only lane whose estimate is provably zero', () => {
    expect(parseLane(undefined)).toBe('free');
  });

  it('accepts the two lanes and refuses anything else', () => {
    expect(parseLane('free')).toBe('free');
    expect(parseLane('paid')).toBe('paid');
    expect(parseLane('cheap')).toBeUndefined();
  });
});

describe('guardSpend', () => {
  it('lets the free lane through and reports zero, whatever estimate it was handed', () => {
    const io = new BufferIo();
    const decision = guardSpend(io, {
      what: 'probe',
      lane: 'free',
      estimateNanoUsd: nanoUsd(999_000_000),
      approved: false,
      json: false,
    });
    expect(decision.proceed).toBe(true);
    // `formatUsd` renders exact zero as `$0.00`; the assertion is that the *free* lane
    // reports zero rather than the estimate it was handed.
    expect(io.errText).toContain('$0.00');
    expect(io.errText).not.toContain('0.9990');
  });

  it('refuses the paid lane without an explicit yes, with exit code 4', () => {
    const io = new BufferIo();
    const decision = guardSpend(io, {
      what: 'probe',
      lane: 'paid',
      estimateNanoUsd: nanoUsd(136_000_000),
      approved: false,
      json: false,
    });
    expect(decision).toEqual({ proceed: false, exit: EXIT.spendRefused });
  });

  it('prints the estimate before it refuses, so the number is on screen either way', () => {
    const io = new BufferIo();
    guardSpend(io, {
      what: 'four tiles',
      lane: 'paid',
      estimateNanoUsd: nanoUsd(136_000_000),
      approved: false,
      json: false,
    });
    expect(io.errText).toContain('$0.1360');
    expect(io.errText).toContain('Nothing has been spent');
  });

  it('carries a stable code and the estimate in the JSON envelope', () => {
    const io = new BufferIo();
    guardSpend(io, {
      what: 'four tiles',
      lane: 'paid',
      estimateNanoUsd: nanoUsd(136_000_000),
      approved: false,
      json: true,
    });
    const envelope = JSON.parse(io.outText) as {
      ok: boolean;
      code: string;
      context: { estimateNanoUsd: number };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('SPEND_NOT_APPROVED');
    expect(envelope.context.estimateNanoUsd).toBe(136_000_000);
  });

  it('proceeds on the paid lane once approved, and still prints the estimate', () => {
    const io = new BufferIo();
    const decision = guardSpend(io, {
      what: 'four tiles',
      lane: 'paid',
      estimateNanoUsd: nanoUsd(136_000_000),
      approved: true,
      json: false,
    });
    expect(decision.proceed).toBe(true);
    expect(io.errText).toContain('$0.1360');
  });

  it('says nothing on stdout under --json when it is letting the call through', () => {
    const io = new BufferIo();
    guardSpend(io, {
      what: 'probe',
      lane: 'free',
      estimateNanoUsd: nanoUsd(0),
      approved: false,
      json: true,
    });
    expect(io.outText).toBe('');
  });
});
