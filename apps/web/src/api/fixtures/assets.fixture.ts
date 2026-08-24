/**
 * A library with something in it, for a session with no API.
 *
 * Modelled on the two assets that are actually in `workspace/rivayat.db` today - the
 * brass wick key and the terrace street lamp, with their real semantic keys and
 * archetypes - plus two that exercise the states those two do not: a version appended
 * over another, and one still rigging. Every record here is parsed by the real `Asset`
 * schema before it reaches a component, so a fixture that drifts from the contract
 * fails a test rather than teaching a screen a shape the pipeline never produces.
 *
 * The failed take is the one that matters. `chained-matting.ts` refuses a matte with
 * *"removed nothing: alpha coverage 0.9912 is above 0.98"*, and that sentence is a
 * diagnosis: the background was never removed, so the cutout is the whole frame. A
 * screen that renders it as "matting failed" throws away the only actionable thing the
 * engine said.
 */

import type { Asset, AssetVariant, AssetVersion, Bone, Part, AnimationClip } from '@rv/contracts';

import type {
  AssetLibraryEntry,
  AssetLibraryPage,
  AssetProduceReport,
  AssetSearchHit,
  ProduceStepRecord,
} from '../schemas/assets';

// ── ids ─────────────────────────────────────────────────────────────────────
// Fixed rather than minted: a fixture that changes identity between reloads cannot be
// linked to, and the studio never mints an id anyway (see `shims/node-crypto.ts`).

const WICK = 'ast_8JJBWQ7KTBNY19WTQAEQGBR9EY';
const LAMP = 'ast_B4P4HEB30JJS8RD7WQ22RSRZHV';
const OAK = 'ast_NMWXGYXR4QWEHKPCQZQ9P2YKM3';
const HERON = 'ast_R7CBWTN6FYETHSQGMR20G7Z48A';

const STYLE_BIBLE = 'sty_01M0QRJ20N5VT5GGFVJC5E2F4R';
const STYLE_CHECKSUM = 'f29eadf1b5e187dcdc96bda4b58e0fb658bce38030696970773861fcd08c3ee9';

/**
 * A stable 64-hex string per seed.
 *
 * Not a digest and not pretending to be one: the studio may not hash at all
 * (`shims/node-crypto.ts` makes `createHash` throw on purpose, because a
 * plausible-but-wrong dedup key is the one failure this system cannot tolerate). These
 * only have to be distinct and well-formed enough for `Sha256Hex` to accept them.
 */
function hex(seed: string): string {
  let accumulator = 0x811c9dc5;
  let out = '';
  for (let round = 0; round < 8; round += 1) {
    for (let index = 0; index < seed.length; index += 1) {
      accumulator ^= seed.charCodeAt(index) + round;
      accumulator = Math.imul(accumulator, 0x01000193) >>> 0;
    }
    out += accumulator.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

/** Widens a fixture literal into the branded id the schema parses it back into. */
function id<T>(value: string): T {
  return value as T;
}

function part(input: {
  id: string;
  name: string;
  role: string;
  zOrder: number;
  alphaCoverage: number;
  deformable?: boolean;
}): Part {
  return {
    id: id<Part['id']>(input.id),
    name: input.name,
    role: input.role,
    imageHash: hex(`part:${input.id}`),
    bounds: { x: 0, y: 0, width: 512, height: 512 },
    size: { width: 512, height: 512 },
    pivot: { x: 0.5, y: 0.9 },
    zOrder: input.zOrder,
    deformable: input.deformable ?? false,
    alphaCoverage: input.alphaCoverage,
  };
}

function bone(
  boneId: string,
  name: string,
  role: string,
  parentId: string | null,
  partIds: readonly string[],
): Bone {
  return {
    id: id<Bone['id']>(boneId),
    name,
    role,
    parentId: parentId === null ? null : id<Bone['id']>(parentId),
    rest: { position: { x: 0, y: 0 }, rotation: 0, length: 120, scale: { x: 1, y: 1 } },
    partIds: partIds.map((value) => id<Part['id']>(value)),
    zOrderBias: 0,
  };
}

function clip(clipId: string, name: string, durationMs: number, baked: boolean): AnimationClip {
  return {
    id: id<AnimationClip['id']>(clipId),
    name,
    source: 'template',
    durationMs,
    fps: 24,
    loop: 'loop',
    irHash: hex(`clip:${clipId}`),
    ...(baked
      ? {
          bakedSheetId: id<NonNullable<AnimationClip['bakedSheetId']>>(
            'atl_9K7ZQWH4T1D8XB3RVE0MNAY52C',
          ),
        }
      : {}),
    tags: [],
    provenance: {
      source: 'derived',
      parents: [],
      createdAt: '2026-08-23T17:06:46.497Z',
      costNanoUsd: 0,
    },
  };
}

function variant(input: {
  id: string;
  key: string;
  label: string;
  replacedParts: Record<string, string>;
  createdAt: string;
  costNanoUsd: number;
  parents: readonly string[];
}): AssetVariant {
  return {
    id: id<AssetVariant['id']>(input.id),
    key: input.key,
    label: input.label,
    replacedParts: input.replacedParts,
    provenance: {
      source: 'derived',
      model: 'gemini:gemini-3.1-flash-image',
      parents: [...input.parents],
      createdAt: input.createdAt,
      costNanoUsd: input.costNanoUsd,
    },
  };
}

function version(input: {
  id: string;
  assetId: string;
  ordinal: number;
  status: AssetVersion['status'];
  archetype: Asset['archetype'];
  templateId: string;
  parts: readonly Part[];
  bones: readonly Bone[];
  clips: readonly AnimationClip[];
  variants?: readonly AssetVariant[];
  costNanoUsd: number;
  model: string;
  createdAt: string;
  scores?: AssetVersion['scores'];
}): AssetVersion {
  const root = input.bones[0];
  return {
    id: id<AssetVersion['id']>(input.id),
    assetId: id<AssetVersion['assetId']>(input.assetId),
    ordinal: input.ordinal,
    status: input.status,
    styleBibleId: id<AssetVersion['styleBibleId']>(STYLE_BIBLE),
    styleChecksum: STYLE_CHECKSUM,
    parts: [...input.parts],
    rig: {
      id: id<NonNullable<AssetVersion['rig']>['id']>(`rig_${input.id.slice(4)}`),
      archetype: input.archetype,
      templateId: input.templateId,
      bones: [...input.bones],
      meshes: [],
      ikChains: [],
      anchors:
        root === undefined
          ? []
          : [{ name: 'centre', boneId: root.id, offset: { x: 0, y: 0 }, rotation: 0 }],
    },
    variants: [...(input.variants ?? [])],
    clips: [...input.clips],
    canvas: { width: 512, height: 512 },
    nominalHeight: 512,
    previewImageHash: hex(`preview:${input.id}`),
    quality: 'preview',
    ...(input.scores === undefined ? {} : { scores: input.scores }),
    provenance: {
      source: 'image-model',
      model: input.model,
      promptHash: hex(`prompt:${input.id}`),
      seed: 1_284_112,
      parents: [STYLE_CHECKSUM],
      createdAt: input.createdAt,
      costNanoUsd: input.costNanoUsd,
    },
  };
}

// ── the assets ──────────────────────────────────────────────────────────────

const WICK_V1 = 'asv_01M0QRJHER5GA9685X5SVNP66Z';
const LAMP_V1 = 'asv_01M0QSDJJZ39Z6909AETYCSKJ0';
const LAMP_V2 = 'asv_5NQKW8ZT3DB2RJX9HMC0VF7A64';
const OAK_V1 = 'asv_9WQKB3ZT5DR1XNH7JMC2VF0A84';
const HERON_V1 = 'asv_4HQKB9ZT2DR6XNH1JMC7VF5A30';

const wickKey: Asset = {
  id: id<Asset['id']>(WICK),
  key: id<Asset['key']>(hex('key:wick')),
  semanticKey: 'prop/wick-key/brass',
  archetype: 'rigid-prop',
  label: 'Brass wick key',
  description: 'A small worn brass wick key, one solid piece, seen flat from the side',
  tags: ['prop', 'brass'],
  versions: [
    version({
      id: WICK_V1,
      assetId: WICK,
      ordinal: 1,
      status: 'ready',
      archetype: 'rigid-prop',
      templateId: 'rigid-prop-single',
      parts: [
        part({
          id: 'prt_4TQ9XWJ2B6ZK8HFRV5C0DN35EV',
          name: 'body',
          role: 'body',
          zOrder: 0,
          alphaCoverage: 0.31,
        }),
      ],
      bones: [
        bone('bon_01M0QRJGRVTMBPAH3JGA4VM1K2', 'body', 'body', null, [
          'prt_4TQ9XWJ2B6ZK8HFRV5C0DN35EV',
        ]),
      ],
      clips: [
        clip('clp_2W8HRKQ5YB1NXTZ3F7JDM06AVE', 'idle', 2000, true),
        clip('clp_5MDQXB9V0TKR2NHJ7ZC1WA8SF4', 'turn', 1200, false),
      ],
      costNanoUsd: 0,
      model: 'comfyui:dreamshaper_8.safetensors',
      createdAt: '2026-08-23T16:52:00.601Z',
      scores: {
        styleMatch: 0.91,
        alphaCleanliness: 0.88,
        silhouetteReadability: 0.94,
        partCompleteness: 1,
        overall: 0.91,
      },
    }),
  ],
  currentVersionId: id<Asset['currentVersionId']>(WICK_V1),
  createdAt: '2026-08-23T16:52:00.601Z',
  updatedAt: '2026-08-23T16:52:00.601Z',
};

const LAMP_PARTS = [
  part({
    id: 'prt_7HZQ2XKW9B4TRN6VJ0CDM8ARRM',
    name: 'base',
    role: 'base',
    zOrder: 0,
    alphaCoverage: 0.22,
  }),
  part({
    id: 'prt_9CMTF3JQ0XW7BZK5RHDN2V0S0H',
    name: 'post-lower',
    role: 'post',
    zOrder: 1,
    alphaCoverage: 0.18,
  }),
  part({
    id: 'prt_1XKDQ8WZ5MT4RJH0BNC7VFZ5K5',
    name: 'post-upper',
    role: 'post',
    zOrder: 2,
    alphaCoverage: 0.16,
  }),
  part({
    id: 'prt_3ZTBW6QJ9DK1XNH5RMC0VFY8WW',
    name: 'lantern',
    role: 'head',
    zOrder: 3,
    alphaCoverage: 0.44,
  }),
] as const;

const LAMP_BONES = [
  bone('bon_6QDXW2ZK8TB4RJN0HMC5VF0FJH', 'base', 'root', null, ['prt_7HZQ2XKW9B4TRN6VJ0CDM8ARRM']),
  bone('bon_8WKZQ3XT9DB2RJN5HMC0VFPE3T', 'post', 'post', 'bon_6QDXW2ZK8TB4RJN0HMC5VF0FJH', [
    'prt_9CMTF3JQ0XW7BZK5RHDN2V0S0H',
    'prt_1XKDQ8WZ5MT4RJH0BNC7VFZ5K5',
  ]),
  bone('bon_2TXQW8ZK5DB9RJN3HMC7VFBJR1', 'head', 'head', 'bon_8WKZQ3XT9DB2RJN5HMC0VFPE3T', [
    'prt_3ZTBW6QJ9DK1XNH5RMC0VFY8WW',
  ]),
] as const;

const streetLamp: Asset = {
  id: id<Asset['id']>(LAMP),
  key: id<Asset['key']>(hex('key:lamp')),
  semanticKey: 'prop/street-lamp/terrace',
  archetype: 'articulated-prop',
  label: 'Terrace street lamp',
  description:
    'A cast-iron street lamp in four separate pieces: the round mounting base, the lower post, the upper post, and the glass lantern head',
  tags: ['prop', 'street'],
  versions: [
    version({
      id: LAMP_V1,
      assetId: LAMP,
      ordinal: 1,
      status: 'ready',
      archetype: 'articulated-prop',
      templateId: 'articulated-prop-chain',
      parts: LAMP_PARTS,
      bones: LAMP_BONES,
      clips: [clip('clp_4RJQW9ZK2TB7XNH0DMC5VFWEET', 'idle', 2400, true)],
      costNanoUsd: 0,
      model: 'comfyui:dreamshaper_8.safetensors',
      createdAt: '2026-08-23T17:06:46.497Z',
      scores: {
        styleMatch: 0.84,
        alphaCleanliness: 0.71,
        silhouetteReadability: 0.88,
        partCompleteness: 1,
        overall: 0.81,
      },
    }),
    version({
      id: LAMP_V2,
      assetId: LAMP,
      ordinal: 2,
      status: 'ready',
      archetype: 'articulated-prop',
      templateId: 'articulated-prop-chain',
      parts: LAMP_PARTS,
      bones: LAMP_BONES,
      clips: [
        clip('clp_7BQKW2ZT9DR4XNH5JMC0VFJJ6G', 'idle', 2400, true),
        clip('clp_0DQKW5ZT7BR2XNH9JMC4VF0M1H', 'flicker', 1600, false),
      ],
      variants: [
        variant({
          id: 'vnt_3KQBW7ZT0DR9XNH2JMC5VFY6FA',
          key: 'night-lit',
          label: 'Night, lit',
          replacedParts: { lantern: hex('variant:lantern:night') },
          createdAt: '2026-08-23T18:11:02.004Z',
          costNanoUsd: 3_900_000,
          parents: [LAMP_V2],
        }),
      ],
      costNanoUsd: 21_000_000,
      model: 'gemini:gemini-3.1-flash-image',
      createdAt: '2026-08-23T18:02:19.220Z',
      scores: {
        styleMatch: 0.93,
        alphaCleanliness: 0.9,
        silhouetteReadability: 0.92,
        partCompleteness: 1,
        overall: 0.92,
      },
    }),
  ],
  currentVersionId: id<Asset['currentVersionId']>(LAMP_V2),
  createdAt: '2026-08-23T17:06:46.497Z',
  updatedAt: '2026-08-23T18:11:02.004Z',
};

const OAK_PARTS = [
  part({
    id: 'prt_5QZBW3XT8DK1RNH7JMC0VF6VH7',
    name: 'trunk',
    role: 'trunk',
    zOrder: 0,
    alphaCoverage: 0.27,
  }),
  part({
    id: 'prt_8TZBW1XQ4DK7RNH2JMC9VF34FP',
    name: 'branch-left',
    role: 'branch',
    zOrder: 1,
    alphaCoverage: 0.19,
    deformable: true,
  }),
  part({
    id: 'prt_2QZBW9XT5DK3RNH8JMC1VFEMH3',
    name: 'branch-right',
    role: 'branch',
    zOrder: 2,
    alphaCoverage: 0.21,
    deformable: true,
  }),
  part({
    id: 'prt_6QZBW2XT7DK9RNH4JMC3VFXE3M',
    name: 'canopy-back',
    role: 'canopy',
    zOrder: 3,
    alphaCoverage: 0.63,
    deformable: true,
  }),
  part({
    id: 'prt_0QZBW4XT1DK6RNH9JMC8VFA5EH',
    name: 'canopy-front',
    role: 'canopy',
    zOrder: 4,
    alphaCoverage: 0.58,
    deformable: true,
  }),
] as const;

const oakTree: Asset = {
  id: id<Asset['id']>(OAK),
  key: id<Asset['key']>(hex('key:oak')),
  semanticKey: 'flora/oak-tree/mature',
  archetype: 'tree',
  label: 'Mature oak',
  description: 'A gnarled mature oak with a heavy canopy, drawn in five separable layers',
  tags: ['flora', 'hero'],
  versions: [
    version({
      id: OAK_V1,
      assetId: OAK,
      ordinal: 1,
      status: 'ready',
      archetype: 'tree',
      templateId: 'tree-branching',
      parts: OAK_PARTS,
      bones: [
        bone('bon_4WQKB9ZT1DR5XNH3JMC7VFEVMS', 'trunk', 'trunk', null, [
          'prt_5QZBW3XT8DK1RNH7JMC0VF6VH7',
        ]),
        bone(
          'bon_7WQKB2ZT8DR3XNH1JMC5VFFV3Q',
          'branch-l',
          'branch',
          'bon_4WQKB9ZT1DR5XNH3JMC7VFEVMS',
          ['prt_8TZBW1XQ4DK7RNH2JMC9VF34FP'],
        ),
        bone(
          'bon_1WQKB5ZT3DR9XNH8JMC0VFS0E9',
          'branch-r',
          'branch',
          'bon_4WQKB9ZT1DR5XNH3JMC7VFEVMS',
          ['prt_2QZBW9XT5DK3RNH8JMC1VFEMH3'],
        ),
      ],
      clips: [
        clip('clp_8WQKB1ZT6DR4XNH0JMC3VFF4D6', 'idle', 3200, true),
        clip('clp_3WQKB7ZT2DR8XNH5JMC1VFS42J', 'breeze', 4800, true),
        clip('clp_6WQKB0ZT9DR2XNH4JMC8VF09SM', 'gust', 2600, false),
      ],
      variants: [
        variant({
          id: 'vnt_9ZQKB4ZT1DR7XNH0JMC6VFPSMM',
          key: 'winter',
          label: 'Winter, bare',
          replacedParts: {
            'canopy-back': hex('variant:oak:winter:back'),
            'canopy-front': hex('variant:oak:winter:front'),
          },
          createdAt: '2026-08-23T18:44:51.900Z',
          costNanoUsd: 7_800_000,
          parents: [OAK_V1],
        }),
        variant({
          id: 'vnt_2ZQKB8ZT5DR0XNH3JMC9VF8HYM',
          key: 'autumn',
          label: 'Autumn',
          replacedParts: { 'canopy-front': hex('variant:oak:autumn:front') },
          createdAt: '2026-08-23T18:47:03.118Z',
          costNanoUsd: 3_900_000,
          parents: [OAK_V1],
        }),
      ],
      costNanoUsd: 48_000_000,
      model: 'gemini:gemini-3.1-flash-image',
      createdAt: '2026-08-23T18:40:12.774Z',
      scores: {
        styleMatch: 0.96,
        alphaCleanliness: 0.93,
        silhouetteReadability: 0.97,
        partCompleteness: 1,
        overall: 0.95,
      },
    }),
  ],
  currentVersionId: id<Asset['currentVersionId']>(OAK_V1),
  createdAt: '2026-08-23T18:40:12.774Z',
  updatedAt: '2026-08-23T18:47:03.118Z',
};

const heron: Asset = {
  id: id<Asset['id']>(HERON),
  key: id<Asset['key']>(hex('key:heron')),
  semanticKey: 'fauna/heron/adult',
  archetype: 'winged',
  label: 'Grey heron',
  description: 'An adult grey heron in three parts so far: body and both wings',
  tags: ['fauna'],
  versions: [
    version({
      id: HERON_V1,
      assetId: HERON,
      ordinal: 1,
      status: 'rigging',
      archetype: 'winged',
      templateId: 'winged-two-wing',
      parts: [
        part({
          id: 'prt_7HQKB3ZT9DR1XNH6JMC2VF3DR2',
          name: 'body',
          role: 'body',
          zOrder: 0,
          alphaCoverage: 0.34,
        }),
        part({
          id: 'prt_1HQKB6ZT4DR8XNH9JMC3VF8PGC',
          name: 'wing-left',
          role: 'wing-l',
          zOrder: 1,
          alphaCoverage: 0.29,
        }),
        part({
          id: 'prt_5HQKB0ZT7DR3XNH2JMC9VF1GX7',
          name: 'wing-right',
          role: 'wing-r',
          zOrder: 2,
          alphaCoverage: 0.28,
        }),
      ],
      bones: [
        bone('bon_9HQKB5ZT0DR7XNH4JMC1VFCWGK', 'body', 'body', null, [
          'prt_7HQKB3ZT9DR1XNH6JMC2VF3DR2',
        ]),
      ],
      clips: [],
      costNanoUsd: 12_400_000,
      model: 'gemini:gemini-3.1-flash-image',
      createdAt: '2026-08-23T19:22:40.512Z',
    }),
  ],
  currentVersionId: id<Asset['currentVersionId']>(HERON_V1),
  createdAt: '2026-08-23T19:22:40.512Z',
  updatedAt: '2026-08-23T19:22:40.512Z',
};

export const ASSET_FIXTURES: readonly Asset[] = [wickKey, streetLamp, oakTree, heron];

// ── produce reports ─────────────────────────────────────────────────────────

const ALL_RAN: readonly ProduceStepRecord[] = [
  { step: 'generate', outcome: 'ran', attempt: 0, durationMs: 18_400, costNanoUsd: 0 },
  { step: 'matte', outcome: 'ran', attempt: 0, durationMs: 1_320, costNanoUsd: 0 },
  { step: 'split', outcome: 'ran', attempt: 0, durationMs: 640, costNanoUsd: 0 },
  { step: 'score', outcome: 'ran', attempt: 0, durationMs: 2_100, costNanoUsd: 0 },
  { step: 'rig', outcome: 'ran', attempt: 0, durationMs: 310, costNanoUsd: 0 },
  { step: 'clips', outcome: 'ran', attempt: 0, durationMs: 90, costNanoUsd: 0 },
  { step: 'bake', outcome: 'ran', attempt: 0, durationMs: 4_800, costNanoUsd: 0 },
  { step: 'register', outcome: 'ran', attempt: 0, durationMs: 40, costNanoUsd: 0 },
];

/**
 * The take that stopped at step two of eight.
 *
 * Verbatim from `chained-matting.ts`, because paraphrasing it into "matting failed"
 * loses the number the user needs: coverage above the ceiling means the matte kept
 * everything, so the background is still there and the cutout is the whole frame.
 */
const MATTE_FAILURE: readonly ProduceStepRecord[] = [
  {
    step: 'generate',
    outcome: 'ran',
    attempt: 0,
    durationMs: 21_900,
    costNanoUsd: 0,
    detail: 'comfyui:dreamshaper_8.safetensors, 1 image, seed 1284112',
  },
  {
    step: 'matte',
    outcome: 'failed',
    attempt: 1,
    durationMs: 2_640,
    costNanoUsd: 0,
    detail:
      'every engine refused this cutout. rembg-u2net: removed nothing: alpha coverage 0.9912 is above 0.98. threshold-strict: removed nothing: alpha coverage 0.9903 is above 0.98. threshold-loose: removed the subject: alpha coverage 0.0041 is below 0.05.',
  },
  { step: 'split', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
  { step: 'score', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
  { step: 'rig', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
  { step: 'clips', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
  { step: 'bake', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
  { step: 'register', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
];

const HERON_IN_PROGRESS: readonly ProduceStepRecord[] = [
  { step: 'generate', outcome: 'ran', attempt: 0, durationMs: 26_100, costNanoUsd: 12_400_000 },
  { step: 'matte', outcome: 'ran', attempt: 0, durationMs: 1_910, costNanoUsd: 0 },
  { step: 'split', outcome: 'ran', attempt: 0, durationMs: 880, costNanoUsd: 0 },
  {
    step: 'score',
    outcome: 'resumed',
    attempt: 0,
    durationMs: 0,
    costNanoUsd: 0,
    detail: 'checkpoint covers these inputs; the vision gate did not run again',
  },
  { step: 'rig', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
  { step: 'clips', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
  { step: 'bake', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
  { step: 'register', outcome: 'not-reached', attempt: 0, durationMs: 0, costNanoUsd: 0 },
];

function report(input: {
  seed: string;
  semanticKey: string;
  label: string;
  assetId?: string;
  versionId?: string;
  steps: readonly ProduceStepRecord[];
  failedStep?: AssetProduceReport['failedStep'];
  spentNanoUsd: number;
}): AssetProduceReport {
  return {
    key: id<AssetProduceReport['key']>(hex(input.seed)),
    semanticKey: input.semanticKey,
    label: input.label,
    ...(input.assetId === undefined
      ? {}
      : { assetId: id<NonNullable<AssetProduceReport['assetId']>>(input.assetId) }),
    ...(input.versionId === undefined
      ? {}
      : { versionId: id<NonNullable<AssetProduceReport['versionId']>>(input.versionId) }),
    steps: [...input.steps],
    ...(input.failedStep === undefined ? {} : { failedStep: input.failedStep }),
    spentNanoUsd: input.spentNanoUsd,
  };
}

function paidAtGenerate(nanoUsd: number): ProduceStepRecord[] {
  return ALL_RAN.map((record) =>
    record.step === 'generate' ? { ...record, costNanoUsd: nanoUsd } : record,
  );
}

/** Keyed by version id, because a report is about one take and not about the asset. */
export const PRODUCE_REPORTS: Readonly<Record<string, AssetProduceReport>> = {
  [WICK_V1]: report({
    seed: 'key:wick',
    semanticKey: 'prop/wick-key/brass',
    label: 'Brass wick key',
    assetId: WICK,
    versionId: WICK_V1,
    steps: ALL_RAN,
    spentNanoUsd: 0,
  }),
  [LAMP_V1]: report({
    seed: 'key:lamp',
    semanticKey: 'prop/street-lamp/terrace',
    label: 'Terrace street lamp',
    assetId: LAMP,
    versionId: LAMP_V1,
    steps: ALL_RAN,
    spentNanoUsd: 0,
  }),
  [LAMP_V2]: report({
    seed: 'key:lamp',
    semanticKey: 'prop/street-lamp/terrace',
    label: 'Terrace street lamp',
    assetId: LAMP,
    versionId: LAMP_V2,
    steps: paidAtGenerate(21_000_000),
    spentNanoUsd: 21_000_000,
  }),
  [OAK_V1]: report({
    seed: 'key:oak',
    semanticKey: 'flora/oak-tree/mature',
    label: 'Mature oak',
    assetId: OAK,
    versionId: OAK_V1,
    steps: paidAtGenerate(48_000_000),
    spentNanoUsd: 48_000_000,
  }),
  [HERON_V1]: report({
    seed: 'key:heron',
    semanticKey: 'fauna/heron/adult',
    label: 'Grey heron',
    assetId: HERON,
    versionId: HERON_V1,
    steps: HERON_IN_PROGRESS,
    spentNanoUsd: 12_400_000,
  }),
};

/** A take with no asset and no version: it never reached `register`. */
export const INCOMPLETE_TAKES: readonly AssetProduceReport[] = [
  report({
    seed: 'key:lantern-glass',
    semanticKey: 'prop/lantern-glass/etched',
    label: 'Etched lantern glass',
    steps: MATTE_FAILURE,
    failedStep: 'matte',
    spentNanoUsd: 0,
  }),
];

// ── the list projection ─────────────────────────────────────────────────────

function entryFor(asset: Asset): AssetLibraryEntry {
  // `versions` is `min(1)` in the schema and `currentVersionId` is refined to reference
  // one of them, so both fallbacks are unreachable in valid data. They exist so this
  // projection contains no non-null assertion.
  const current =
    asset.versions.find((candidate) => candidate.id === asset.currentVersionId) ??
    asset.versions[0];
  const spent = asset.versions.reduce(
    (total, entry) =>
      total +
      entry.provenance.costNanoUsd +
      entry.variants.reduce((sum, item) => sum + item.provenance.costNanoUsd, 0),
    0,
  );
  return {
    id: asset.id,
    key: asset.key,
    keyParts: {
      semanticKey: asset.semanticKey,
      styleChecksum: STYLE_CHECKSUM,
      variantKey: 'base',
      specHash: hex(`spec:${asset.semanticKey}`),
    },
    semanticKey: asset.semanticKey,
    archetype: asset.archetype,
    label: asset.label,
    currentVersionId: asset.currentVersionId,
    currentStatus: current?.status ?? 'ready',
    versionCount: asset.versions.length,
    variantCount: asset.versions.reduce((total, entry) => total + entry.variants.length, 0),
    clipCount: current?.clips.length ?? 0,
    partCount: current?.parts.length ?? 0,
    spentNanoUsd: spent,
    updatedAt: asset.updatedAt,
  };
}

export function assetLibraryPage(query: string): AssetLibraryPage {
  const needle = query.trim().toLowerCase();
  const matches = ASSET_FIXTURES.filter(
    (asset) =>
      needle === '' ||
      asset.semanticKey.includes(needle) ||
      asset.label.toLowerCase().includes(needle),
  );
  return {
    assets: matches.map(entryFor),
    total: ASSET_FIXTURES.length,
    incomplete: [...INCOMPLETE_TAKES],
  };
}

export function assetById(assetId: string): Asset | undefined {
  return ASSET_FIXTURES.find((asset) => asset.id === assetId);
}

/**
 * Search, without an embedding model.
 *
 * A substring match dressed up as a similarity score would be a lie about what the real
 * endpoint does, so the floor is applied the same way `FindSimilarAssetsUseCase` applies
 * it: below it the answer is an empty list, never the least-bad match, because a
 * confident wrong suggestion costs more than no suggestion.
 */
export function assetSearchHits(query: string, floor = 0.6): AssetSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  return ASSET_FIXTURES.map((asset) => {
    const haystack = `${asset.label} ${asset.semanticKey} ${asset.description}`.toLowerCase();
    const similarity = haystack.includes(needle)
      ? Math.min(1, 0.62 + needle.length / (asset.label.length + 4))
      : 0.12;
    return {
      assetId: asset.id,
      key: asset.key,
      semanticKey: asset.semanticKey,
      label: asset.label,
      similarity: Number(similarity.toFixed(3)),
    };
  })
    .filter((hit) => hit.similarity >= floor)
    .toSorted(
      (left, right) =>
        right.similarity - left.similarity || left.assetId.localeCompare(right.assetId),
    );
}
