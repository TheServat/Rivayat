import { describe, expect, it } from 'vitest';

import { extractJson, removeTrailingCommas } from './json-extract';

function value(raw: string): unknown {
  const result = extractJson(raw);
  if (!result.ok) throw new Error(`expected extraction to succeed: ${result.error.message}`);
  return result.value.value;
}

function steps(raw: string): readonly string[] {
  const result = extractJson(raw);
  if (!result.ok) throw new Error('expected extraction to succeed');
  return result.value.steps;
}

describe('clean output', () => {
  it('parses bare JSON with no recovery steps', () => {
    expect(value('{"a":1}')).toEqual({ a: 1 });
    expect(steps('{"a":1}')).toEqual([]);
  });

  it('parses a bare array', () => {
    expect(value('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('tolerates surrounding whitespace without calling it a recovery', () => {
    expect(steps('  \n {"a":1}\n ')).toEqual([]);
  });
});

describe('code fences', () => {
  it('unwraps a ```json fence', () => {
    expect(value('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(steps('```json\n{"a":1}\n```')).toEqual(['stripped-code-fence']);
  });

  it('unwraps an unlabelled fence and the json5/jsonc variants', () => {
    for (const label of ['', 'json', 'jsonc', 'json5']) {
      expect(value('```' + label + '\n{"a":1}\n```')).toEqual({ a: 1 });
    }
  });

  it('unwraps a fence buried in conversational padding', () => {
    const raw = 'Sure! Here is the JSON you asked for:\n\n```json\n{"a":1}\n```\n\nLet me know!';
    expect(value(raw)).toEqual({ a: 1 });
  });
});

describe('reasoning blocks', () => {
  it('strips a closed <think> block', () => {
    const raw = '<think>The user wants an object. I will emit one.</think>\n{"a":1}';
    expect(value(raw)).toEqual({ a: 1 });
    expect(steps(raw)).toContain('stripped-think-block');
  });

  it('strips a think block containing braces without eating the real JSON', () => {
    const raw = '<think>maybe {"a":9} or {"a":1}?</think>{"a":1}';
    expect(value(raw)).toEqual({ a: 1 });
  });

  it('reports an unterminated think block rather than guessing', () => {
    // The model ran out of budget mid-reasoning. There is no answer to recover.
    const result = extractJson('<think>I should consider the schema and then');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toMatch(/unterminated reasoning block/);
  });
});

describe('prose around the payload', () => {
  it('extracts a balanced object from a prose sandwich', () => {
    const raw = 'Certainly. {"name":"Kael","age":32} I hope that helps.';
    expect(value(raw)).toEqual({ name: 'Kael', age: 32 });
    expect(steps(raw)).toContain('extracted-balanced-span');
  });

  it('does not break on braces inside a string value', () => {
    // The naive indexOf/lastIndexOf approach truncates here, which is exactly the bug
    // that shows up the first time a character description mentions a brace.
    const raw = 'Result: {"note":"he wrote { and } on the wall","ok":true} done';
    expect(value(raw)).toEqual({ note: 'he wrote { and } on the wall', ok: true });
  });

  it('handles escaped quotes inside strings', () => {
    const raw = 'x {"quote":"she said \\"stop\\"","n":1} y';
    expect(value(raw)).toEqual({ quote: 'she said "stop"', n: 1 });
  });

  it('handles an escaped backslash immediately before a quote', () => {
    const raw = '{"path":"C:\\\\dir\\\\"}';
    expect(value(raw)).toEqual({ path: 'C:\\dir\\' });
  });

  it('takes the first complete value when several appear', () => {
    expect(value('{"a":1} and then {"b":2}')).toEqual({ a: 1 });
  });

  it('prefers whichever of { or [ comes first', () => {
    expect(value('noise [1,2] {"a":1}')).toEqual([1, 2]);
    expect(value('noise {"a":1} [1,2]')).toEqual({ a: 1 });
  });

  it('handles deep nesting', () => {
    const raw = 'x {"a":{"b":{"c":[{"d":1}]}}} y';
    expect(value(raw)).toEqual({ a: { b: { c: [{ d: 1 }] } } });
  });
});

describe('trailing commas', () => {
  it('recovers an object with a trailing comma and says so', () => {
    const raw = 'here: {"a":1,"b":2,}';
    expect(value(raw)).toEqual({ a: 1, b: 2 });
    expect(steps(raw)).toContain('removed-trailing-commas');
  });

  it('recovers a trailing comma in a nested array', () => {
    expect(value('prefix {"list":[1,2,],}')).toEqual({ list: [1, 2] });
  });

  it('leaves a comma inside a string alone', () => {
    expect(removeTrailingCommas('{"s":"a,}b"}')).toBe('{"s":"a,}b"}');
  });

  it('does not touch a legitimate separator comma', () => {
    expect(removeTrailingCommas('{"a":1,"b":2}')).toBe('{"a":1,"b":2}');
  });

  it('handles an escaped quote while scanning', () => {
    expect(removeTrailingCommas('{"s":"a\\",}","b":1}')).toBe('{"s":"a\\",}","b":1}');
  });
});

describe('failures', () => {
  it('reports empty output', () => {
    const result = extractJson('   ');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toMatch(/no content/i);
  });

  it('reports prose with no JSON at all', () => {
    const result = extractJson('I am sorry, I cannot help with that.');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toMatch(/No JSON object or array/);
  });

  it('reports an unbalanced object rather than parsing a prefix', () => {
    const result = extractJson('{"a":1');
    expect(result.ok).toBe(false);
  });

  it('reports genuinely malformed JSON with a preview for diagnosis', () => {
    const result = extractJson('x {"a": } y');
    expect(result.ok).toBe(false);
    expect(result.ok ? {} : result.error.context).toHaveProperty('preview');
  });
});

describe('combined recovery', () => {
  it('handles the worst realistic case in one pass', () => {
    // Reasoning block, conversational padding, a fence, and a trailing comma - all of
    // which have been observed from local models on this machine.
    const raw = [
      '<think>The schema wants a name and a list.</think>',
      'Absolutely! Here you go:',
      '```json',
      '{"name":"Kael","tags":["brave","tired"],}',
      '```',
      'Hope this helps.',
    ].join('\n');

    expect(value(raw)).toEqual({ name: 'Kael', tags: ['brave', 'tired'] });
    expect(steps(raw)).toEqual(
      expect.arrayContaining(['stripped-think-block', 'stripped-code-fence']),
    );
  });

  it('preserves unicode, including Persian text', () => {
    expect(value('```json\n{"title":"روایت","ok":true}\n```')).toEqual({
      title: 'روایت',
      ok: true,
    });
  });
});
