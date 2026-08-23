import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@rv/shared-kernel';

import { NUMERIC_PLACEHOLDERS, buildGraph } from './workflow';
import { COMFY_WORKFLOW_FILES } from './load-workflows';
import { WORKFLOW_DIR, readWorkflow } from './__fixtures__/workflows';

describe('buildGraph typed substitution', () => {
  it('turns a whole-value numeric placeholder into a JSON number', () => {
    // ComfyUI type-checks INT/FLOAT node inputs and rejects `"steps": "4"`.
    const built = buildGraph(
      { '7': { inputs: { steps: '{{steps}}', seed: '{{seed}}' } } },
      {
        steps: 4,
        seed: 424242,
      },
    );

    expect(isOk(built)).toBe(true);
    if (isOk(built)) {
      const inputs = (built.value.prompt['7'] as { inputs: Record<string, unknown> }).inputs;
      expect(inputs.steps).toBe(4);
      expect(inputs.seed).toBe(424242);
    }
  });

  it('coerces a numeric placeholder given as a string', () => {
    const built = buildGraph({ '7': { inputs: { cfg: '{{cfg}}' } } }, { cfg: '1.5' });
    if (isOk(built)) {
      expect((built.value.prompt['7'] as { inputs: { cfg: unknown } }).inputs.cfg).toBe(1.5);
    }
  });

  it('interpolates a non-whole occurrence as text', () => {
    // The parts-sheet scaffold embeds placeholders mid-sentence.
    const built = buildGraph(
      { '4': { inputs: { text: 'a {{subject}}, {{variant}}' } } },
      {
        subject: 'fox',
        variant: 'winter coat',
      },
    );

    if (isOk(built)) {
      expect((built.value.prompt['4'] as { inputs: { text: string } }).inputs.text).toBe(
        'a fox, winter coat',
      );
    }
  });

  it('keeps a numeric placeholder as text when it is embedded mid-string', () => {
    const built = buildGraph(
      { '9': { inputs: { filename_prefix: 'shot-{{seed}}' } } },
      { seed: 7 },
    );
    if (isOk(built)) {
      expect(
        (built.value.prompt['9'] as { inputs: { filename_prefix: string } }).inputs.filename_prefix,
      ).toBe('shot-7');
    }
  });

  it('fails loudly on a leftover placeholder rather than POSTing it', () => {
    const built = buildGraph({ '4': { inputs: { text: '{{prompt}}' } } }, {});

    expect(isErr(built)).toBe(true);
    if (isErr(built)) {
      expect(built.error.kind).toBe('validation');
      expect(built.error.context.leftovers).toEqual(['{{prompt}}']);
    }
  });

  it('strips `_meta`, which is documentation ComfyUI ignores', () => {
    const built = buildGraph({ '1': { class_type: 'X', _meta: { title: 'doc' }, inputs: {} } }, {});
    if (isOk(built)) {
      expect(built.value.prompt['1']).toEqual({ class_type: 'X', inputs: {} });
    }
  });

  it('records every placeholder the template referenced, sorted', () => {
    const built = buildGraph(
      { '4': { inputs: { text: '{{prompt}} {{negative}}', seed: '{{seed}}' } } },
      { prompt: 'a', negative: 'b', seed: 1 },
    );
    if (isOk(built)) expect(built.value.placeholders).toEqual(['negative', 'prompt', 'seed']);
  });

  it('rejects a workflow that is not an object keyed by node id', () => {
    expect(isErr(buildGraph([1, 2, 3], {}))).toBe(true);
    expect(isErr(buildGraph('nope', {}))).toBe(true);
  });

  it('leaves non-object node values alone', () => {
    const built = buildGraph({ '1': null, '2': 5 }, {});
    if (isOk(built)) expect(built.value.prompt).toEqual({ '1': null, '2': 5 });
  });
});

describe('the numeric placeholder list', () => {
  it('matches the reference implementation in tools/scripts/comfy-smoke.mjs', () => {
    // A silent divergence here produces a graph ComfyUI rejects with a message that
    // names the node rather than the cause, so the two lists are compared directly.
    const source = readFileSync(
      new URL('../../../../../tools/scripts/comfy-smoke.mjs', import.meta.url),
      'utf8',
    );
    const block = /const NUMERIC_PLACEHOLDERS = new Set\(\[([\s\S]*?)\]\);/.exec(source);
    expect(block).not.toBeNull();

    const names = [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(names.sort()).toEqual([...NUMERIC_PLACEHOLDERS].sort());
  });
});

describe('the real workflow files', () => {
  it.each(Object.entries(COMFY_WORKFLOW_FILES))(
    '%s substitutes cleanly with the adapter’s value set',
    (_key, filename) => {
      const workflow = readWorkflow(filename);
      const built = buildGraph(workflow, {
        checkpoint: 'dreamshaper_8.safetensors',
        lora: 'lcm-lora-sdv1-5.safetensors',
        lora_strength: 1,
        sampler: 'lcm',
        scheduler: 'sgm_uniform',
        steps: 6,
        cfg: 1.5,
        batch_size: 1,
        denoise: 0.4,
        width: 512,
        height: 512,
        seed: 0,
        prompt: 'a fox',
        variant: 'winter',
        negative: 'blurry',
        image: 'base.png',
        filename_prefix: 'rivayat',
      });

      expect(isOk(built)).toBe(true);
      if (isOk(built)) {
        expect(JSON.stringify(built.value.prompt)).not.toMatch(/\{\{/);
        expect(JSON.stringify(built.value.prompt)).not.toContain('_meta');
      }
    },
  );

  it('keeps ModelSamplingDiscrete in the draft graph - without it 4-step output is noise', () => {
    const workflow = readWorkflow(COMFY_WORKFLOW_FILES.txt2img) as Record<
      string,
      { class_type?: string }
    >;
    const classes = Object.values(workflow).map((node) => node.class_type);
    expect(classes).toContain('ModelSamplingDiscrete');
  });

  it('lives where the loader looks for it', () => {
    expect(() => readFileSync(`${WORKFLOW_DIR}${COMFY_WORKFLOW_FILES.txt2img}`)).not.toThrow();
  });
});
