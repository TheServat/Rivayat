import { describe, expect, it } from 'vitest';

import { ARIA, KAEL, valeEntities } from '../__fixtures__/vale';
import { character, entityId } from '../__fixtures__/builders';
import { MentionResolver, ResolutionLog } from './coreference';

function resolver(): MentionResolver {
  return new MentionResolver(valeEntities());
}

describe('MentionResolver', () => {
  it('matches a canonical name, whatever the case', () => {
    expect(resolver().resolve('KAEL')).toEqual({ ok: true, entityId: KAEL });
  });

  it('matches an alias', () => {
    expect(resolver().resolve('the boy')).toEqual({ ok: true, entityId: KAEL });
    expect(resolver().resolve('the steward')).toEqual({ ok: true, entityId: ARIA });
  });

  it('strips articles, punctuation and possessives before comparing', () => {
    expect(resolver().resolve('The Vale,')).toEqual({ ok: true, entityId: entityId('the vale') });
    expect(resolver().resolve("Kael's")).toEqual({ ok: true, entityId: KAEL });
  });

  it('folds combining marks, so a vocalised spelling still matches', () => {
    expect(resolver().resolve('Káel')).toEqual({ ok: true, entityId: KAEL });
  });

  it('matches a distinctive token from a longer alias', () => {
    expect(resolver().resolve('Ardent')).toEqual({ ok: true, entityId: KAEL });
  });

  it('refuses a name that matches two nodes, and says which', () => {
    const twins = new MentionResolver([
      character('kael', { canonicalName: 'Kael Ardent' }),
      character('kaela', { canonicalName: 'Kaela Ardent' }),
    ]);
    const outcome = twins.resolve('Ardent');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('ambiguous');
    expect(outcome.candidates).toHaveLength(2);
    expect(outcome.candidates).toEqual([...outcome.candidates].sort());
  });

  it('never guesses at an edit-distance near-miss', () => {
    const outcome = resolver().resolve('Kaal');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unknown');
    expect(outcome.candidates).toEqual([]);
  });

  it('reports an empty mention as unknown rather than throwing', () => {
    expect(resolver().resolve('   ').ok).toBe(false);
    expect(resolver().resolve('!!').ok).toBe(false);
  });

  it('resolves something registered mid-extraction', () => {
    const index = resolver();
    const ghost = entityId('the ledger');
    expect(index.resolve('the ledger').ok).toBe(false);
    index.register(ghost, ['the ledger']);
    expect(index.resolve('the ledger')).toEqual({ ok: true, entityId: ghost });
  });

  it('resolves an empty graph to nothing rather than to anything', () => {
    expect(new MentionResolver().resolve('Kael').ok).toBe(false);
  });
});

describe('ResolutionLog', () => {
  it('records every failure with the field it came from', () => {
    const log = new ResolutionLog(resolver());
    expect(log.resolve('Kael', 'relations.subject')).toBe(KAEL);
    expect(log.resolve('Nobody', 'relations.object')).toBeUndefined();
    expect(log.resolve('Also nobody', 'relations.subject')).toBeUndefined();

    expect(log.unresolved).toEqual([
      { mention: 'Nobody', reason: 'unknown', candidates: [], where: 'relations.object' },
      { mention: 'Also nobody', reason: 'unknown', candidates: [], where: 'relations.subject' },
    ]);
  });

  it('passes a null mention through without recording anything', () => {
    const log = new ResolutionLog(resolver());
    expect(log.resolveNullable(null, 'movements.to')).toBeNull();
    expect(log.resolveNullable('the Vale', 'movements.to')).toBe(entityId('the vale'));
    expect(log.unresolved).toEqual([]);
  });

  it('orders failures deterministically', () => {
    const log = new ResolutionLog(resolver());
    log.resolve('zeta', 'b');
    log.resolve('alpha', 'b');
    log.resolve('omega', 'a');
    expect(log.unresolved.map((entry) => `${entry.where}:${entry.mention}`)).toEqual([
      'a:omega',
      'b:alpha',
      'b:zeta',
    ]);
  });
});
