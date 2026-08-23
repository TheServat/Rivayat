import { describe, expect, it } from 'vitest';

import { castMember, contrastingVoicePayload, IDS } from '../__fixtures__/builders';
import {
  ART_DIRECTOR,
  CONTINUITY_EDITOR,
  DIRECTOR,
  FIXED_ROLES,
  PRODUCER,
  ROLE_IDS,
  SCREENWRITER,
  actorRoleFor,
  buildRole,
} from './index';
import { PREMISE_CLARITY, RUBRIC_DIMENSIONS, describeRubric } from './rubrics';
import { SCREENWRITER_PROMPT } from './prompts';

const ALL_FIXED = [SCREENWRITER, DIRECTOR, PRODUCER, CONTINUITY_EDITOR, ART_DIRECTOR];

describe('agent roles', () => {
  it('gives every fixed role a rendered prompt, a rubric and somewhere to run', () => {
    for (const role of ALL_FIXED) {
      expect(role.systemPrompt.length).toBeGreaterThan(200);
      expect(role.systemPrompt).not.toContain('{{');
      expect(role.rubric.length).toBeGreaterThan(0);
      expect(role.systemPromptHash).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('registers a role for every id except the actor, which has no fixed instance', () => {
    const registered = Object.keys(FIXED_ROLES);
    expect(new Set(registered)).toEqual(new Set(ROLE_IDS.filter((id) => id !== 'actor')));
  });

  it('routes the roles to different stages so a per-stage pin can reach one of them', () => {
    const stages = new Set(ALL_FIXED.map((role) => role.stage));
    expect(stages.size).toBeGreaterThan(1);
    expect(SCREENWRITER.stage).toBe('story');
    expect(PRODUCER.stage).toBe('intake');
    expect(ART_DIRECTOR.stage).toBe('cast');
  });

  it('pins the continuity editor to temperature zero - an editor that improvises is not one', () => {
    expect(CONTINUITY_EDITOR.temperature).toBe(0);
    expect(SCREENWRITER.temperature).toBeGreaterThan(0);
  });

  it('hashes the same role identically across two builds, so the cache can hit', () => {
    const rebuilt = buildRole({
      id: 'screenwriter',
      title: 'Screenwriter',
      stage: 'story',
      task: 'story-outline',
      tier: 'final',
      temperature: 0.7,
      template: SCREENWRITER_PROMPT,
      vars: {},
      rubric: [PREMISE_CLARITY],
    });
    expect(rebuilt.systemPromptHash).toBe(SCREENWRITER.systemPromptHash);
  });
});

describe('actorRoleFor', () => {
  const mahtab = castMember('Mahtab', IDS.mahtab);
  const other = castMember('Roya', IDS.roya, contrastingVoicePayload());

  it("binds the prompt to that character's voice block", () => {
    const role = actorRoleFor(mahtab);
    expect(role.systemPrompt).toContain('Mahtab');
    expect(role.systemPrompt).toContain('colloquial');
    expect(role.systemPrompt).toContain('staccato');
    expect(role.systemPrompt).toContain('aye then');
  });

  it('produces a different prompt per character - this is what stops one voice for all', () => {
    const first = actorRoleFor(mahtab);
    const second = actorRoleFor(other);
    expect(first.systemPromptHash).not.toBe(second.systemPromptHash);
    expect(second.systemPrompt).toContain('poetic');
    expect(second.systemPrompt).not.toContain('staccato');
  });

  it('keeps the role id stable so the ledger can still attribute the cost', () => {
    expect(actorRoleFor(mahtab).id).toBe('actor');
    expect(actorRoleFor(mahtab).title).toBe('Mahtab (actor)');
  });

  it('names the empty case rather than emitting a blank instruction', () => {
    const silent = castMember('Silent', IDS.roya, {
      voice: { ...mahtab.payload.voice, idiolect: [], verbalTics: [] },
    });
    expect(actorRoleFor(silent).systemPrompt).toContain('none recorded');
  });
});

describe('rubrics', () => {
  it('exposes every dimension by its key', () => {
    expect(RUBRIC_DIMENSIONS['premise-clarity']).toBe(PREMISE_CLARITY);
    for (const [key, dimension] of Object.entries(RUBRIC_DIMENSIONS)) {
      expect(dimension.key).toBe(key);
      expect(dimension.failsBelow).toBeGreaterThan(0);
      expect(dimension.failsBelow).toBeLessThanOrEqual(1);
    }
  });

  it('renders a rubric as a numbered list carrying every key', () => {
    const rendered = describeRubric(SCREENWRITER.rubric);
    for (const dimension of SCREENWRITER.rubric) {
      expect(rendered).toContain(dimension.key);
    }
    expect(rendered.startsWith('1. ')).toBe(true);
  });
});
