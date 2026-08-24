/**
 * `rv graph show --character kael --at E05` and `rv continuity check --episode E06`.
 *
 * The two M2 demo lines that make the world model visible. Both are pure reads over a
 * `NarrativeGraph` rebuilt from `world.json` - the graph is never persisted, only the
 * deltas that produce it, so a stored graph can never disagree with the edges that made
 * it.
 *
 * `graph show` is `buildEpistemicView`, which is the thing worth demonstrating: it
 * answers "what does Kael know at E05", not "what is true at E05". The difference is
 * `believesFalsely` and `blindSpots`, and a scene writer handed the second question
 * writes a character who knows what they were never told.
 *
 * `continuity check` runs the **free** rule pass by default. The semantic pass costs
 * money, so it is behind `--semantic` and the spend guard, which is the same split the
 * use-case documents: "a pipeline running the check on every save wants the free pass;
 * the one gating an air date wants both."
 */

import { EntityId, blocksAiring } from '@rv/contracts';
import {
  CheckEpisodeContinuityUseCase,
  NarrativeGraph,
  buildEpistemicView,
  type SceneUnderCheck,
} from '@rv/narrative-memory';
import { NotFoundError, isErr, nanoUsd, type AppError, type Result } from '@rv/shared-kernel';

import { buildTextBackends } from '../adapters/lanes';
import { flag, option, type ParsedArgs } from '../cli/args';
import type { Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, fail, usageError } from '../cli/report';
import { guardSpend, parseLane } from '../cli/spend';
import { keyValues, table } from '../cli/text';
import { WorldDocument, type SceneCheckEntry } from '../store/documents';
import { readJson } from '../store/json-file';
import { resolveProject, type LoadedProject } from '../store/project';
import { findEpisode, loadStory } from './story';

/** Rebuilds the graph from the stored deltas. Sorting and hashing are the graph's own. */
export function graphFrom(world: WorldDocument): NarrativeGraph {
  return new NarrativeGraph({
    seriesId: world.seriesId,
    entities: world.entities,
    relations: world.relations,
    facts: world.facts,
    openLoops: world.openLoops,
    vitality: world.vitality,
    episodeOrder: world.episodeOrder,
    airedEpisodes: world.airedEpisodes,
  });
}

async function loadWorld(project: LoadedProject): Promise<Result<WorldDocument, AppError>> {
  const world = await readJson(project.paths.world, WorldDocument, 'world');
  if (isErr(world) && world.error.kind === 'not-found') {
    return {
      ok: false,
      error: new NotFoundError('world model', project.paths.world, {
        context: {
          hint: 'S4 writes this. Until the CLI runs S4 you can seed it by hand: it is a NarrativeGraphInput plus scenesByEpisode.',
        },
      }),
    };
  }
  return world;
}

/**
 * Resolves `--at E05` to a story time.
 *
 * Episodes are the handle a person has; the graph indexes on `StoryTime`, whose ordinal
 * is "an arbitrary total order". Mapping the episode's broadcast position onto the
 * ordinal is the only mapping the CLI can make without a story-time table, and it is
 * stated here rather than hidden so a series with flashbacks knows to pass `--ordinal`.
 */
function storyTimeFor(ordinal: number): { ordinal: number; label?: string } {
  return { ordinal };
}

export const graphShowCommand: Command = {
  path: ['graph', 'show'],
  summary: 'what one character knows, believes falsely, and cannot see, at one episode',
  usage: [
    'rv graph show --character <entityId|slug> [--at <E05>] [--ordinal <n>] [--omniscient]',
    '              [--project <id>] [--json]',
    '  --at         the episode whose broadcast position fixes the story time',
    '  --ordinal    the story ordinal directly, for a series with flashbacks',
    '  --omniscient the author view: every current fact, no blind spots',
  ],
  booleans: ['omniscient'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const character = option(args, 'character');
    if (character === undefined) {
      return usageError(context.io, 'Which character? e.g. rv graph show --character kael', json);
    }

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const world = await loadWorld(project.value);
    if (isErr(world)) return fail(context.io, world.error, { json });

    const graph = graphFrom(world.value);
    const viewer = resolveEntity(graph, character);
    if (viewer === undefined) {
      return fail(
        context.io,
        new NotFoundError('entity', character, {
          context: { known: graph.entities.map((entity) => entity.canonicalName).slice(0, 40) },
        }),
        { json },
      );
    }

    const ordinal = await resolveOrdinal(
      project.value,
      option(args, 'at'),
      option(args, 'ordinal'),
    );
    const view = buildEpistemicView(graph, viewer, {
      at: storyTimeFor(ordinal),
      asOf: context.clock.now(),
      ...(flag(args, 'omniscient') ? { omniscient: true } : {}),
    });

    if (json) {
      emitJson(context.io, view);
      return EXIT.ok;
    }

    context.io.out();
    for (const line of keyValues([
      ['viewer', viewer],
      ['at ordinal', String(ordinal)],
      ['knows', String(view.knows.length)],
      ['believes falsely', String(view.believesFalsely.length)],
      ['suspects', String(view.suspects.length)],
      ['blind spots', String(view.blindSpots.length)],
      ['truncated', view.truncated ? `yes (${String(view.factCount)} total)` : 'no'],
    ])) {
      context.io.out(line);
    }

    // `blindSpots` is a list of relation ids, not of facts: the whole point is that the
    // viewer does not hold them, so there is no statement in their head to print.
    const rows = [
      ...view.knows.map((held) => ['knows', held.relationId, held.fact]),
      ...view.believesFalsely.map((held) => ['believes-falsely', held.relationId, held.fact]),
      ...view.suspects.map((held) => ['suspects', held.relationId, held.fact]),
      ...view.blindSpots.map((relationId) => ['blind-spot', relationId, '(not known to them)']),
    ];
    if (rows.length > 0) {
      context.io.out();
      for (const line of table({
        columns: [{ header: 'stance' }, { header: 'relation' }, { header: 'statement' }],
        indent: '  ',
        rows,
      })) {
        context.io.out(line);
      }
    }
    context.io.out();
    return EXIT.ok;
  },
};

export const continuityCheckCommand: Command = {
  path: ['continuity', 'check'],
  summary: 'rule pass over one episode; exits 3 when a contradiction blocks airing',
  usage: [
    'rv continuity check --episode <E06> [--semantic] [--lane free|paid] [--yes]',
    '                    [--project <id>] [--json]',
    '  --semantic  also run the model pass over what the rules could not decide (costs money)',
  ],
  booleans: ['semantic'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const handle = option(args, 'episode');
    if (handle === undefined) {
      return usageError(context.io, 'Which episode? e.g. rv continuity check --episode E06', json);
    }
    const lane = parseLane(option(args, 'lane'));
    if (lane === undefined) return usageError(context.io, '--lane must be "free" or "paid"', json);

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const world = await loadWorld(project.value);
    if (isErr(world)) return fail(context.io, world.error, { json });

    const episodeId = await resolveEpisodeId(project.value, handle);
    const scenes = world.value.scenesByEpisode[episodeId] ?? [];
    if (scenes.length === 0) {
      return fail(
        context.io,
        new NotFoundError('scenes for episode', handle, {
          context: {
            resolvedTo: episodeId,
            known: Object.keys(world.value.scenesByEpisode),
          },
        }),
        { json },
      );
    }

    const semantic = flag(args, 'semantic');
    if (semantic) {
      const decision = guardSpend(context.io, {
        what: `semantic continuity pass over ${handle}`,
        lane,
        estimateNanoUsd: nanoUsd(lane === 'free' ? 0 : 30_000_000),
        approved: flag(args, 'yes'),
        json,
      });
      if (!decision.proceed) return decision.exit;
    }

    const backends = semantic
      ? buildTextBackends({
          env: context.env,
          clock: context.clock,
          binding: option(args, 'model'),
        })
      : null;

    const check = new CheckEpisodeContinuityUseCase({
      clock: context.clock,
      ...(backends !== null && backends.ok && backends.value.chain.length > 0
        ? { backends: backends.value.chain }
        : {}),
    });

    const report = await check.execute({
      graph: graphFrom(world.value),
      episodeId,
      scenes: scenes.map(toSceneUnderCheck),
      asOf: context.clock.now(),
      ...(semantic ? { semantic: true } : {}),
    });
    if (isErr(report)) return fail(context.io, report.error, { json });

    if (json) {
      emitJson(context.io, {
        episode: handle,
        episodeId,
        blocked: report.value.blocked,
        errors: report.value.errors,
        warnings: report.value.warnings,
        citedFacts: report.value.citedFacts.map((fact) => fact.id),
      });
      return report.value.blocked ? EXIT.findings : EXIT.ok;
    }

    context.io.out();
    if (report.value.issues.length === 0) {
      context.io.out(`  ${handle}: no continuity findings. Airing is not blocked.`);
      context.io.out();
      return EXIT.ok;
    }

    for (const line of table({
      columns: [
        { header: 'severity' },
        { header: 'rule' },
        { header: 'scene' },
        { header: 'explanation' },
      ],
      indent: '  ',
      rows: report.value.issues.map((issue) => [
        blocksAiring(issue) ? 'ERROR' : 'warn',
        issue.rule,
        issue.sceneId ?? '-',
        issue.explanation.slice(0, 100),
      ]),
    })) {
      context.io.out(line);
    }
    context.io.out();
    context.io.out(
      report.value.blocked
        ? `  ${String(report.value.errors.length)} error(s) block airing ${handle}.`
        : `  ${String(report.value.warnings.length)} warning(s); airing ${handle} is not blocked.`,
    );
    context.io.out();
    return report.value.blocked ? EXIT.findings : EXIT.ok;
  },
};

/**
 * Drops absent optionals rather than passing `undefined`.
 *
 * `exactOptionalPropertyTypes` makes `{ note?: string }` and `{ note: string | undefined }`
 * different types, and Zod's `.optional()` produces the second. The engine declares the
 * first, so the conversion is a conditional spread and not a cast.
 */
function toSceneUnderCheck(scene: SceneCheckEntry): SceneUnderCheck {
  return {
    sceneId: scene.sceneId,
    at: scene.at,
    locationId: scene.locationId,
    presentEntityIds: scene.presentEntityIds,
    actingEntityIds: scene.actingEntityIds,
    usesKnowledge: scene.usesKnowledge.map((use) => ({
      knowerId: use.knowerId,
      relationId: use.relationId,
      ...(use.note === undefined ? {} : { note: use.note }),
    })),
    wardrobe: scene.wardrobe,
    props: scene.props,
    statedAges: scene.statedAges,
    ...(scene.synopsis === undefined ? {} : { synopsis: scene.synopsis }),
  };
}

/**
 * Accepts an entity id or the name/slug a person types.
 *
 * A well-formed id is taken verbatim even when the graph holds no node for it. The
 * epistemic view is computed over *edges*, and a graph folded from deltas can carry
 * relations about an entity whose sheet S3 has not written yet - refusing the query
 * there would report "no such character" about a character the graph plainly knows
 * things about.
 */
function resolveEntity(graph: NarrativeGraph, handle: string): EntityId | undefined {
  const direct = graph.entities.find((entity) => entity.id === handle);
  if (direct !== undefined) return direct.id;

  const asId = EntityId.safeParse(handle);
  if (asId.success) return asId.data;
  const wanted = handle.trim().toLowerCase();
  return graph.entities.find((entity) =>
    [entity.canonicalName, ...entity.aliases].some(
      (name) =>
        name.toLowerCase() === wanted ||
        name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-') === wanted,
    ),
  )?.id;
}

/** `E05` becomes the episode's broadcast position; a number is taken as given. */
async function resolveOrdinal(
  project: LoadedProject,
  at: string | undefined,
  explicit: string | undefined,
): Promise<number> {
  const direct = Number(explicit);
  if (Number.isFinite(direct) && explicit !== undefined) return direct;
  if (at === undefined) return Number.MAX_SAFE_INTEGER;

  const story = await loadStory(project.paths.story);
  if (story.ok) {
    const episode = findEpisode(story.value, at);
    if (episode !== undefined) return episode.ordinal;
  }
  const fromCode = Number(at.replace(/^[A-Za-z]+/, ''));
  return Number.isFinite(fromCode) ? fromCode : Number.MAX_SAFE_INTEGER;
}

/** `E06` becomes the stored episode's id when a story exists; otherwise it is the key. */
async function resolveEpisodeId(project: LoadedProject, handle: string): Promise<string> {
  const story = await loadStory(project.paths.story);
  if (!story.ok) return handle;
  return findEpisode(story.value, handle)?.id ?? handle;
}
