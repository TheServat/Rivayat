/**
 * `rv cast states --character <c> --print` - the M2 demo line.
 *
 * "8 expressions, 6 poses, 2 wardrobes, each with its prompt" is `STATE_MINIMA` in
 * `@rv/story-engine`, and the top-up loop that reaches it lives in
 * `GenerateCharacterStatesUseCase`. This command generates a set once and prints it
 * from then on, because the demo is about *reading* the prompt behind every cell - the
 * point of CHIRON's psychology-first sheet is that the prompt is derived and editable,
 * not that it is regenerated on demand.
 *
 * `--print` is therefore the read path and the default is "generate if absent, then
 * print". A command that silently re-ran a nine-call generation because a file was
 * missing would be the most expensive typo in the tool.
 */

import { StyleBible } from '@rv/contracts';
import { StructuredCall } from '@rv/prompt-kit';
import {
  FixedStageBackends,
  GenerateCharacterSheetUseCase,
  GenerateCharacterStatesUseCase,
  styleBriefFrom,
  type StoryEngineDeps,
} from '@rv/story-engine';
import {
  MemoryLogger,
  NotFoundError,
  ValidationError,
  isErr,
  nanoUsd,
  toIso,
} from '@rv/shared-kernel';
import { join } from 'node:path';

import { buildTextBackends } from '../adapters/lanes';
import { flag, option, type ParsedArgs } from '../cli/args';
import type { Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, fail, usageError } from '../cli/report';
import { guardSpend, parseLane } from '../cli/spend';
import { keyValues, table } from '../cli/text';
import {
  CharacterStatesDocument,
  DOCUMENT_VERSION,
  type CharacterStateEntry,
} from '../store/documents';
import { readJson, readJsonOrNull, writeJson } from '../store/json-file';
import { resolveProject } from '../store/project';
import { loadStory } from './story';

export const castStatesCommand: Command = {
  path: ['cast', 'states'],
  summary: 'every expression, pose and wardrobe a character needs, with the prompt behind each',
  usage: [
    'rv cast states --character <slug> [--print] [--regenerate] [--model <provider:model>]',
    '               [--lane free|paid] [--project <id>] [--json]',
    '  --print       read the stored set; never calls a model',
    '  --regenerate  discard the stored set and ask again (a new document, not an edit)',
  ],
  booleans: ['print', 'regenerate'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const character = option(args, 'character');
    if (character === undefined) {
      return usageError(context.io, 'Which character? e.g. rv cast states --character kael', json);
    }
    const lane = parseLane(option(args, 'lane'));
    if (lane === undefined) return usageError(context.io, '--lane must be "free" or "paid"', json);

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const path = join(project.value.paths.castDir, `${character}.json`);
    const existing = await readJsonOrNull(path, CharacterStatesDocument, 'character states');
    if (isErr(existing)) return fail(context.io, existing.error, { json });

    if (existing.value !== null && !flag(args, 'regenerate')) {
      return print(context, existing.value, json);
    }

    if (flag(args, 'print')) {
      return fail(
        context.io,
        new NotFoundError('character states', character, {
          context: { path, hint: 'generate them first: rv cast states --character ' + character },
        }),
        { json },
      );
    }

    // ── generation ───────────────────────────────────────────────────────────

    const story = await loadStory(project.value.paths.story);
    if (isErr(story)) return fail(context.io, story.error, { json });

    const member = story.value.cast.find((entry) => entry.slug === character);
    if (member === undefined) {
      return fail(
        context.io,
        new NotFoundError('character', character, {
          context: { known: story.value.cast.map((entry) => entry.slug) },
        }),
        { json },
      );
    }

    const bible = await readJson(project.value.paths.style, StyleBible, 'style bible');
    if (isErr(bible)) return fail(context.io, bible.error, { json });

    const backends = buildTextBackends({
      env: context.env,
      clock: context.clock,
      binding: option(args, 'model'),
    });
    if (isErr(backends)) return fail(context.io, backends.error, { json });
    if (backends.value.chain.length === 0) {
      return fail(
        context.io,
        new ValidationError({
          message: `No backend is available for "${backends.value.modelRef}" on this machine`,
        }),
        { json },
      );
    }

    const decision = guardSpend(context.io, {
      what: `character sheet + state set for ${character}`,
      lane,
      estimateNanoUsd: nanoUsd(lane === 'free' ? 0 : 120_000_000),
      approved: flag(args, 'yes'),
      json,
    });
    if (!decision.proceed) return decision.exit;

    const logger = new MemoryLogger();
    const deps: StoryEngineDeps = {
      structured: new StructuredCall({ logger }),
      backends: new FixedStageBackends(backends.value.chain),
      clock: context.clock,
      ids: context.ids,
      logger,
    };
    const style = styleBriefFrom(bible.value);

    context.io.err(`  S3 character sheet for ${member.name} …`);
    const sheet = await new GenerateCharacterSheetUseCase(deps).execute({
      context: {
        seriesTitle: story.value.title,
        premise: story.value.premise,
        themes: [...story.value.themes],
        tone: [...story.value.tone],
        genre: [...story.value.genre],
        worldRules: [],
        canonPolicy: story.value.canonPolicy,
        episodeDurationMs: story.value.episodeDurationMs,
      },
      candidate: {
        name: member.name,
        role: member.role as 'protagonist',
        importance: member.importance as 'lead',
        premiseRole: member.premiseRole,
        distinguishingTrait: member.distinguishingTrait,
      },
      style,
    });
    if (isErr(sheet)) return fail(context.io, sheet.error, { json });

    context.io.err('  S3 state set (expressions, poses, wardrobe) …');
    const states = await new GenerateCharacterStatesUseCase(deps).execute({
      name: sheet.value.name,
      payload: sheet.value.payload,
      style,
      characterSlug: character,
    });
    if (isErr(states)) return fail(context.io, states.error, { json });

    const entries: CharacterStateEntry[] = [
      ...states.value.expressionSet.map((state) => toEntry(state, 'expression')),
      ...states.value.poseSet.map((state) => toEntry(state, 'pose')),
      ...states.value.wardrobe.map((outfit) => ({
        slug: outfit.slug,
        kind: 'wardrobe' as const,
        label: outfit.label,
        description: outfit.description,
        prompt: outfit.description,
      })),
    ];

    const written = await writeJson(path, CharacterStatesDocument, {
      version: DOCUMENT_VERSION,
      projectId: project.value.record.id,
      characterSlug: states.value.characterSlug,
      name: sheet.value.name,
      states: entries,
      variants: states.value.variants.map((variant) => ({
        semanticKey: variant.semanticKey,
        variantKey: variant.variantKey,
        label: variant.label,
        prompt: variant.prompt,
      })),
      createdAt: toIso(context.clock.now()),
    });
    if (isErr(written)) return fail(context.io, written.error, { json });

    return print(context, written.value, json);
  },
};

function toEntry(
  state: { slug: string; label: string; description: string },
  kind: 'expression' | 'pose',
): CharacterStateEntry {
  return {
    slug: state.slug,
    kind,
    label: state.label,
    description: state.description,
    prompt: state.description,
  };
}

function print(context: CliContext, document: CharacterStatesDocument, json: boolean): ExitCode {
  if (json) {
    emitJson(context.io, document);
    return EXIT.ok;
  }

  const counts = { expression: 0, pose: 0, wardrobe: 0 };
  for (const state of document.states) counts[state.kind] += 1;

  context.io.out();
  for (const line of keyValues([
    ['character', document.characterSlug],
    ['name', document.name],
    ['expressions', String(counts.expression)],
    ['poses', String(counts.pose)],
    ['wardrobes', String(counts.wardrobe)],
    ['variants', String(document.variants.length)],
  ])) {
    context.io.out(line);
  }

  context.io.out();
  for (const line of table({
    columns: [{ header: 'kind' }, { header: 'slug' }, { header: 'label' }, { header: 'prompt' }],
    indent: '  ',
    rows: document.states.map((state) => [
      state.kind,
      state.slug,
      state.label,
      state.prompt.replaceAll('\n', ' ').slice(0, 110),
    ]),
  })) {
    context.io.out(line);
  }
  context.io.out();
  return EXIT.ok;
}
