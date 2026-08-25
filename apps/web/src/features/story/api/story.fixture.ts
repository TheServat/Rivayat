/**
 * A story tree that behaves like one, for the sessions that have no server.
 *
 * Not a canned snapshot: it holds the tree, grows it one level at a time, refuses a
 * level skip, appends a version on every edit and marks the children of an edited node
 * stale. Those four behaviours are exactly what this screen is judged on, and a table
 * of frozen responses would let all four be broken and still look right.
 *
 * Reached only when the whole studio is running on recorded data — `createTransport`
 * makes that opt-in and the shell shows a badge for it. Against a real server the HTTP
 * gateway is used and gets an honest 404 for routes the API has not built.
 *
 * The content is Persian because the seeded project on the live API is Persian and the
 * two should feel like the same product. Content is data, not interface: the studio
 * chrome around it is bilingual, the series it is showing is not.
 */

import { SeriesCard, type SeriesId, type ProjectId } from '@rv/contracts';

import { IntakeReport, type StoryBrief } from './intake';

import { ApiError } from '../../../api/errors';

import {
  OUTLINE_LEVELS,
  type OutlineLevel,
  type StoryExpansion,
  type StoryNode,
  type StoryNodeEdit,
  type StoryRoleId,
  type StoryTree,
  descendantIdsOf,
} from './story-tree';

const SERIES_ID = 'ser_01JQZK3M7X8YB4N2VTC6WPHRDF' as SeriesId;
const PROJECT_ID = 'prj_01JQZK3M7X8YB4N2VTC6WPHRDE' as ProjectId;

export const FIXTURE_SERIES: readonly SeriesCard[] = [
  {
    id: SERIES_ID,
    projectId: PROJECT_ID,
    title: 'نگهبان چاه',
    premise:
      'بی‌بی گلاب چهل سال است باغ انار را تنها آب می‌دهد و نمی‌گذارد کسی به چاه نزدیک شود. دخترکی که شب‌ها از دیوار بالا می‌رود چیزی دیده که نباید، و مهندسی مؤدب از پایتخت آمده تا همان چاه را اندازه بگیرد.',
    hasBible: true,
    createdAt: '2026-08-19T09:12:00+03:30',
  },
];

/** A stable instant per node, so nothing here reads a clock. */
function instantFor(index: number): string {
  const minute = String(index % 60).padStart(2, '0');
  const hour = String(9 + Math.floor(index / 60)).padStart(2, '0');
  return `2026-08-19T${hour}:${minute}:00+03:30`;
}

interface Authored {
  readonly title: string;
  readonly planned: string;
  readonly summary: string;
}

/** Which role writes a given level, and what one node of it costs at the seeded binding. */
const LEVEL_ROLE: Readonly<Record<OutlineLevel, StoryRoleId>> = {
  series: 'producer',
  season: 'screenwriter',
  episode: 'screenwriter',
  act: 'screenwriter',
  sequence: 'screenwriter',
  scene: 'director',
  beat: 'director',
};

const LEVEL_COST_NANO_USD: Readonly<Record<OutlineLevel, number>> = {
  series: 0,
  season: 0,
  episode: 2_400_000,
  act: 1_100_000,
  sequence: 700_000,
  scene: 520_000,
  beat: 180_000,
};

const LEVEL_MODEL: Readonly<Record<OutlineLevel, string>> = {
  series: 'ollama:qwen3.5:latest',
  season: 'ollama:qwen3.5:latest',
  episode: 'openrouter:z-ai/glm-5.2:free',
  act: 'openrouter:z-ai/glm-5.2:free',
  sequence: 'openrouter:z-ai/glm-5.2:free',
  scene: 'ollama:qwen3.5:latest',
  beat: 'ollama:qwen3.5:latest',
};

// ── the authored content, level by level ────────────────────────────────────

const SERIES: Authored = {
  title: 'نگهبان چاه',
  planned:
    'ایدهٔ نویسنده: باغی دیواربسته، چاهی ممنوع، و سه نفر که هرکدام تکه‌ای از حقیقت را دارند.',
  summary:
    'یک مجموعهٔ کوتاه بر پایهٔ افسانه‌های شفاهی کویر. باغ انار پشت دیوار است، چاه وسط باغ، و بی‌بی گلاب میان آن دو ایستاده است. هر قسمت یک نفر تازه به چاه نزدیک می‌شود و چیزی از گذشتهٔ باغ را بیرون می‌کشد.',
};

const SEASON: Authored = {
  title: 'تابستان کم‌آب',
  planned: 'یک فصل: از رسیدن مهندس تا شبی که آب پایین می‌رود و ته چاه دیده می‌شود.',
  summary:
    'کم‌آبی تابستان همه را به سمت چاه می‌راند. آنچه بی‌بی گلاب چهل سال پنهان کرده بود، نه با اعتراف او، که با پایین رفتن سطح آب رو می‌آید.',
};

const EPISODES: readonly Authored[] = [
  {
    title: 'مهمانِ اندازه‌گیر',
    planned: 'قسمت اول: مهندس می‌رسد و باغ برای اولین بار در برابر یک کاغذ رسمی می‌ایستد.',
    summary:
      'فرهاد با نامه‌ای از ادارهٔ آب می‌آید تا چاه را اندازه بگیرد. بی‌بی گلاب مؤدب اما بی‌گذشت جلوی او می‌ایستد، و مهتاب که از دیوار بالا می‌رفته، اولین بار می‌بیند که بی‌بی از چیزی می‌ترسد.',
  },
  {
    title: 'چیزی که در آب است',
    planned: 'قسمت دوم: آب پایین می‌رود و آنچه ته چاه است دیگر پنهان نمی‌ماند.',
    summary:
      'سطح آب یک متر پایین می‌رود. مهتاب شبانه پایین می‌رود و چیزی می‌آورد که به روایتی که تمام عمرش شنیده نمی‌خورد. فرهاد می‌فهمد گزارشش دیگر فقط دربارهٔ آب نیست.',
  },
];

/** `[episodeIndex]` -> the acts of that episode. */
const ACTS: readonly (readonly Authored[])[] = [
  [
    {
      title: 'نامه',
      planned: 'پردهٔ یک: مهندس با اختیار قانونی وارد می‌شود.',
      summary:
        'فرهاد در گرمای ظهر به دروازهٔ باغ می‌رسد. نامه را نشان می‌دهد، بی‌بی گلاب چای می‌آورد و اجازه نمی‌دهد. هیچ‌کس صدایش را بلند نمی‌کند و هیچ‌کس عقب نمی‌نشیند.',
    },
    {
      title: 'دیوار',
      planned: 'پردهٔ دو: چیزی که از بیرون دیده نمی‌شود، از بالای دیوار دیده می‌شود.',
      summary:
        'مهتاب شب از دیوار بالا می‌رود و می‌بیند بی‌بی گلاب سر چاه نشسته و با آن حرف می‌زند. اولین بار است که ترس را در صورت پیرزن می‌بیند و نمی‌داند با آن چه کند.',
    },
  ],
  [
    {
      title: 'یک متر پایین‌تر',
      planned: 'پردهٔ یک: کم‌آبی کاری می‌کند که هیچ‌کس نمی‌خواست.',
      summary:
        'سطح آب پایین می‌رود و لبهٔ چیزی فلزی از آب بیرون می‌زند. بی‌بی گلاب دستور می‌دهد چاه را بپوشانند؛ فرهاد می‌گوید پوشاندن چاه در گزارش می‌آید.',
    },
    {
      title: 'طناب',
      planned: 'پردهٔ دو: کسی باید پایین برود، و کسی که می‌رود جوان‌ترین است.',
      summary:
        'مهتاب با طناب پایین می‌رود. آنچه بالا می‌آورد کوچک است و همه‌چیز را عوض می‌کند: بی‌بی گلاب برای اولین بار می‌نشیند.',
    },
  ],
];

/** Sequence titles, indexed by act. Two per act. */
const SEQUENCES: readonly (readonly Authored[])[] = [
  [
    {
      title: 'رسیدن',
      planned: 'آیا فرهاد از دروازه رد می‌شود؟',
      summary: 'فرهاد می‌رسد، معرفی می‌شود، و به اندازهٔ یک استکان چای اجازهٔ ماندن می‌گیرد.',
    },
    {
      title: 'چای و نه',
      planned: 'آیا نامه به کار می‌آید؟',
      summary: 'بی‌بی گلاب نامه را می‌خواند، تعارف می‌کند، و بدون یک کلمهٔ تند جواب رد می‌دهد.',
    },
  ],
  [
    {
      title: 'بالا رفتن',
      planned: 'آیا مهتاب بی‌آنکه دیده شود بالا می‌رود؟',
      summary: 'مهتاب از همان جای همیشگی بالا می‌رود، ولی این بار باغ خالی نیست.',
    },
    {
      title: 'حرف زدن با چاه',
      planned: 'آیا مهتاب می‌فهمد بی‌بی به چه می‌گوید؟',
      summary: 'مهتاب صدای بی‌بی را می‌شنود و اسمی می‌شنود که تا امروز فکر می‌کرد اسم خودش است.',
    },
  ],
  [
    {
      title: 'اندازه‌گیری',
      planned: 'آیا فرهاد عدد را ثبت می‌کند؟',
      summary: 'فرهاد عمق را می‌گیرد و عدد با چیزی که در پرونده نوشته‌اند نمی‌خواند.',
    },
    {
      title: 'دستور پوشاندن',
      planned: 'آیا چاه پوشانده می‌شود؟',
      summary:
        'بی‌بی گلاب می‌خواهد چاه را بپوشانند و فرهاد یادآوری می‌کند که این کار در گزارش می‌آید.',
    },
  ],
  [
    {
      title: 'گره طناب',
      planned: 'آیا کسی پایین می‌رود؟',
      summary:
        'سر طناب سه بار گره می‌خورد. مهتاب پیش از آنکه کسی جلویش را بگیرد پا در حلقه می‌گذارد.',
    },
    {
      title: 'آنچه بالا می‌آید',
      planned: 'آیا آنچه بالا می‌آید روایت را عوض می‌کند؟',
      summary:
        'یک قوطی حلبی زنگ‌زده با یک شناسنامه در آن. بی‌بی گلاب می‌نشیند و دیگر بلند نمی‌شود.',
    },
  ],
];

/** Two scenes per sequence, sixteen in all, indexed by sequence position. */
const SCENES: readonly Authored[] = [
  { title: 'دروازه، ظهر', planned: 'ورود', summary: 'فرهاد در گرما پشت دروازه منتظر می‌ماند.' },
  { title: 'حیاط، سایهٔ انار', planned: 'معرفی', summary: 'بی‌بی گلاب او را زیر درخت می‌نشاند.' },
  {
    title: 'ایوان، چای',
    planned: 'نامه',
    summary: 'نامه دست‌به‌دست می‌شود و کسی بلند حرف نمی‌زند.',
  },
  { title: 'ایوان، بعد از چای', planned: 'جواب', summary: 'جواب «نه» است و مؤدبانه گفته می‌شود.' },
  { title: 'دیوار شرقی، شب', planned: 'بالا رفتن', summary: 'مهتاب از شکاف همیشگی بالا می‌رود.' },
  { title: 'باغ، پشت انارها', planned: 'دیدن', summary: 'باغ خالی نیست؛ چراغی سر چاه روشن است.' },
  { title: 'سر چاه، شب', planned: 'شنیدن', summary: 'بی‌بی گلاب با چاه حرف می‌زند و اسمی می‌برد.' },
  { title: 'دیوار، برگشت', planned: 'فرار', summary: 'مهتاب برمی‌گردد و تا صبح نمی‌خوابد.' },
  { title: 'سر چاه، صبح', planned: 'اندازه', summary: 'فرهاد شاقول را پایین می‌فرستد.' },
  { title: 'دفترچه', planned: 'عدد', summary: 'عدد با پرونده نمی‌خواند و فرهاد دو بار می‌سنجد.' },
  {
    title: 'انبار',
    planned: 'تخته‌ها',
    summary: 'بی‌بی گلاب تخته می‌آورد تا دهانهٔ چاه را ببندد.',
  },
  {
    title: 'سر چاه، ظهر',
    planned: 'ایستادن',
    summary: 'فرهاد جلوی تخته‌ها می‌ایستد، بی‌آنکه دست بلند کند.',
  },
  {
    title: 'حیاط، عصر',
    planned: 'طناب',
    summary: 'طناب از انبار بیرون می‌آید و کسی نمی‌پرسد برای چه.',
  },
  {
    title: 'دهانهٔ چاه',
    planned: 'پایین رفتن',
    summary: 'مهتاب پا در حلقه می‌گذارد و پایین می‌رود.',
  },
  { title: 'ته چاه', planned: 'پیدا کردن', summary: 'در تاریکی چیزی فلزی به پایش می‌خورد.' },
  { title: 'سر چاه، غروب', planned: 'بالا آمدن', summary: 'قوطی باز می‌شود و باغ ساکت می‌شود.' },
];

/** Two beats per scene, thirty-two in all. `function` is the structural job. */
const BEATS: readonly (readonly Authored[])[] = SCENES.map((scene, index) => [
  {
    title: `${scene.title} — ورود`,
    planned: 'شروع صحنه',
    summary: `کسی وارد می‌شود و چیزی می‌خواهد که هنوز نگرفته است. (${String(index + 1)})`,
  },
  {
    title: `${scene.title} — چرخش`,
    planned: 'تغییر ارزش',
    summary: 'چیزی گفته یا دیده می‌شود که برگرداندنش ممکن نیست.',
  },
]);

// ── building the tree ───────────────────────────────────────────────────────

function nodeOf(
  id: string,
  parentId: string | null,
  level: OutlineLevel,
  ordinal: number,
  authored: Authored,
  index: number,
): StoryNode {
  return {
    id,
    parentId,
    level,
    ordinal,
    title: authored.title,
    summary: authored.summary,
    plannedSummary: authored.planned,
    status: 'expanded',
    roleId: LEVEL_ROLE[level],
    provenance: {
      source: 'llm',
      model: LEVEL_MODEL[level],
      parents: parentId === null ? [] : [parentId],
      createdAt: instantFor(index),
      costNanoUsd: LEVEL_COST_NANO_USD[level],
    },
    spentNanoUsd: LEVEL_COST_NANO_USD[level],
    history: [],
  };
}

/**
 * A parent together with its position among its own level.
 *
 * The position is carried rather than derived from the array, because regenerating one
 * node expands a single parent and that parent is rarely the first of its level — a
 * `forEach` index would hand it the first parent's children.
 */
interface Placed {
  readonly node: StoryNode;
  readonly index: number;
}

/** Every node of one level, given the parents that already exist. */
function buildLevel(level: OutlineLevel, parents: readonly Placed[]): StoryNode[] {
  if (level === 'series') return [nodeOf('n-series', null, 'series', 1, SERIES, 0)];
  if (level === 'season') {
    return [nodeOf('n-season-1', 'n-series', 'season', 1, SEASON, 1)];
  }

  const built: StoryNode[] = [];
  for (const parent of parents) {
    childrenFor(level, parent.index).forEach((authored, childIndex) => {
      built.push(
        nodeOf(
          `${parent.node.id}-${level}-${String(childIndex + 1)}`,
          parent.node.id,
          level,
          childIndex + 1,
          authored,
          built.length + 2,
        ),
      );
    });
  }
  return built;
}

/** The nodes of a level, each paired with its position in that level. */
function placed(nodes: readonly StoryNode[], level: OutlineLevel): Placed[] {
  return nodes.filter((node) => node.level === level).map((node, index) => ({ node, index }));
}

function childrenFor(level: OutlineLevel, parentIndex: number): readonly Authored[] {
  switch (level) {
    case 'episode':
      return EPISODES;
    case 'act':
      return ACTS[parentIndex] ?? [];
    case 'sequence':
      return SEQUENCES[parentIndex] ?? [];
    case 'scene':
      return [SCENES[parentIndex * 2], SCENES[parentIndex * 2 + 1]].filter(
        (entry): entry is Authored => entry !== undefined,
      );
    case 'beat':
      return BEATS[parentIndex] ?? [];
    default:
      return [];
  }
}

/**
 * The fixture gateway.
 *
 * Everything below mutates one in-memory tree, which is what makes "the edit stuck"
 * and "the children were kept" observable rather than asserted.
 */
export function createStoryFixtureGateway(): {
  listSeries: (projectId: ProjectId) => Promise<readonly SeriesCard[]>;
  createSeries: (
    projectId: ProjectId,
    draft: { readonly title: string; readonly premise: string },
  ) => Promise<SeriesCard>;
  runIntake: (seriesId: SeriesId, brief: StoryBrief) => Promise<IntakeReport>;
  loadIntake: (seriesId: SeriesId) => Promise<IntakeReport>;
  loadTree: (seriesId: SeriesId) => Promise<StoryTree>;
  expandLevel: (seriesId: SeriesId, level: OutlineLevel) => Promise<StoryExpansion>;
  editNode: (nodeId: string, edit: StoryNodeEdit) => Promise<StoryNode>;
  regenerateNode: (nodeId: string) => Promise<StoryExpansion>;
} {
  let nodes: StoryNode[] = [];
  const started: SeriesCard[] = [];
  let shortlist: IntakeReport['castCandidates'] = [];

  const tree = (): StoryTree => ({ seriesId: SERIES_ID, nodes: [...nodes] });

  async function settle<T>(value: T): Promise<T> {
    // `await` so callers exercise the same suspense states a real server produces.
    await Promise.resolve();
    return value;
  }

  return {
    listSeries: (projectId) =>
      settle([
        ...FIXTURE_SERIES.filter((series) => series.projectId === projectId),
        ...started.filter((series) => series.projectId === projectId),
      ]),

    createSeries: (projectId, draft) => {
      const created = SeriesCard.parse({
        id: `ser_01JQZK3M7X8YB4N2VTC6WPH${String(started.length).padStart(3, 'A')}`,
        projectId,
        title: draft.title,
        premise: draft.premise,
        hasBible: false,
        createdAt: instantFor(started.length),
      });
      started.push(created);
      // A new series has no tree. Clearing is what makes the fixture honest: a screen
      // that opened a brand-new series onto the demo outline would prove nothing about
      // the empty state, which is the state that actually needed a control.
      nodes = [];
      return settle(created);
    },

    /**
     * S0, answered from the brief rather than from a model.
     *
     * The shortlist is derived from the idea's own words - the capitalised phrases in it -
     * because a fixture that returned three invented characters would let a screen pass
     * its tests while showing a cast that has nothing to do with what was typed. Two
     * candidates minimum, so the "did intake produce anything" branch is exercised.
     */
    loadIntake: (seriesId) =>
      settle(
        IntakeReport.parse({
          seriesId,
          workingTitle: 'Untitled',
          premise: 'Not yet taken in.',
          // Empty until `runIntake` has been called on this transport, which is the state
          // the screen has to be able to tell apart from "S0 ran and found nobody".
          castCandidates: shortlist,
        }),
      ),

    runIntake: (seriesId, brief) => {
      const source = 'idea' in brief ? brief.idea : (brief.workingTitle ?? '');
      const names = [...new Set(source.match(/[A-Z][a-z]{2,}/g) ?? [])].slice(0, 4);
      const roles = ['protagonist', 'antagonist', 'ally', 'mentor'] as const;
      const report = IntakeReport.parse({
        seriesId,
        workingTitle: brief.workingTitle ?? 'Untitled',
        premise: source,
        castCandidates: (names.length >= 2 ? names : ['The Keeper', 'The Stranger']).map(
          (name, index) => ({
            name,
            role: roles[index % roles.length],
            importance: index === 0 ? 'lead' : 'supporting',
            premiseRole: `What ${name} does to the story.`,
            distinguishingTrait: `The one thing that makes ${name} not interchangeable.`,
          }),
        ),
      });
      shortlist = report.castCandidates;
      return settle(report);
    },

    loadTree: () => settle(tree()),

    expandLevel: async (_seriesId, level) => {
      const index = OUTLINE_LEVELS.indexOf(level);
      const parentLevel = OUTLINE_LEVELS[index - 1];
      const parents = parentLevel === undefined ? [] : placed(nodes, parentLevel);

      if (parentLevel !== undefined && parents.length === 0) {
        throw new ApiError({
          failure: 'api',
          code: 'outline-level-skip',
          kind: 'conflict',
          status: 409,
          message: `"${level}" cannot be expanded before "${parentLevel}" exists`,
          context: { level, parentLevel },
        });
      }
      if (nodes.some((node) => node.level === level)) {
        throw new ApiError({
          failure: 'api',
          code: 'outline-level-exists',
          kind: 'conflict',
          status: 409,
          message: `"${level}" has already been expanded`,
          context: { level },
        });
      }

      const built = buildLevel(level, parents);
      nodes = [...nodes, ...built];
      return settle({
        seriesId: SERIES_ID,
        level,
        nodes: built,
        spentNanoUsd: built.reduce((sum, node) => sum + node.spentNanoUsd, 0),
      });
    },

    editNode: async (nodeId, edit) => {
      const current = nodes.find((node) => node.id === nodeId);
      if (current === undefined) {
        throw new ApiError({
          failure: 'api',
          code: 'story-node-not-found',
          kind: 'not-found',
          status: 404,
          message: `no story node ${nodeId}`,
        });
      }

      const edited: StoryNode = {
        ...current,
        title: edit.title,
        summary: edit.summary,
        status: 'expanded',
        roleId: null,
        provenance: {
          source: 'author',
          parents: current.parentId === null ? [] : [current.parentId],
          createdAt: instantFor(nodes.length),
          costNanoUsd: 0,
        },
        history: [
          ...current.history,
          {
            ordinal: current.history.length + 1,
            title: current.title,
            summary: current.summary,
            at: current.provenance?.createdAt ?? instantFor(0),
          },
        ],
      };

      const descendants = new Set(descendantIdsOf(tree(), nodeId));
      nodes = nodes.map((node) => {
        if (node.id === nodeId) return edited;
        if (!descendants.has(node.id)) return node;
        // "Keep" marks; "re-expand" drops. Marking rather than deleting is what makes
        // keeping the children a real answer instead of a label on a destructive act.
        return edit.children === 'keep' ? { ...node, status: 'stale' as const } : node;
      });
      if (edit.children === 're-expand') {
        nodes = nodes.filter((node) => !descendants.has(node.id));
      }
      return settle(edited);
    },

    regenerateNode: async (nodeId) => {
      const current = nodes.find((node) => node.id === nodeId);
      if (current === undefined) {
        throw new ApiError({
          failure: 'api',
          code: 'story-node-not-found',
          kind: 'not-found',
          status: 404,
          message: `no story node ${nodeId}`,
        });
      }
      const childLevel = OUTLINE_LEVELS[OUTLINE_LEVELS.indexOf(current.level) + 1];
      if (childLevel === undefined) {
        return settle({ seriesId: SERIES_ID, level: current.level, nodes: [], spentNanoUsd: 0 });
      }

      const descendants = new Set(descendantIdsOf(tree(), nodeId));
      const position = placed(nodes, current.level).find((entry) => entry.node.id === nodeId);
      const rebuilt = position === undefined ? [] : buildLevel(childLevel, [position]);

      nodes = [...nodes.filter((node) => !descendants.has(node.id)), ...rebuilt];
      return settle({
        seriesId: SERIES_ID,
        level: childLevel,
        nodes: rebuilt,
        spentNanoUsd: rebuilt.reduce((sum, node) => sum + node.spentNanoUsd, 0),
      });
    },
  };
}
