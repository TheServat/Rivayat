/**
 * English messages for the Asset library screen. Mirror of `../fa/assets.ts`.
 *
 * Typed through `MessageSchema`, which is inferred from the Persian catalogue, so
 * this file cannot silently fall behind it.
 */
export default {
  title: 'Asset library',
  subtitle: 'Every asset is generated once and reused forever.',

  summary: {
    count: 'No assets | One asset | {count} assets',
    spend: 'Library spend to date: {amount}',
  },

  loading: 'Reading the library…',

  empty: {
    heading: 'Nothing has been generated yet.',
    body: 'When an episode runs, everything visible in a scene is made here once and kept forever.',
  },

  unavailable: {
    heading: 'This part is not built on the server yet.',
    body: 'The API does not serve the asset list. The screen is ready and will work the moment the route lands.',
    endpoint: 'Missing route: {method} {path}',
    story: 'Delivered by: {story}',
  },

  search: {
    label: 'Semantic search',
    hint: 'Persian or English. Finds the nearest asset that already exists, before anything is made.',
    placeholder: 'e.g. a gnarled old tree',
    submit: 'Search',
    clear: 'Clear the search',
    running: 'Searching…',
    results: 'No matches | One match | {count} matches',
    none: 'Nothing was close enough. A confident wrong suggestion costs more than no suggestion.',
    similarity: '{value} similar',
    costNote:
      'This search embeds the query, which is one provider call, so it runs on submit rather than on every keystroke.',
  },

  columns: {
    asset: 'Asset',
    key: 'Dedup key',
    status: 'Status',
    versions: 'Versions',
    variants: 'Variants',
    clips: 'Clips',
    parts: 'Parts',
    spend: 'Spend',
    updated: 'Updated',
  },

  open: 'Open {label}',

  status: {
    generating: 'Generating',
    matting: 'Matting',
    rigging: 'Rigging',
    ready: 'Ready',
    rejected: 'Rejected',
    failed: 'Failed',
  },

  representation: {
    heading: 'Representation',
    hint: 'Derived from the parts and the rig, not declared by the contract. Style says how it looks; this says how it is built and animated.',
    derived: 'Derived',
    flat: 'Flat image',
    cutout: 'Cutout',
    'cutout-mesh': 'Cutout with mesh',
    unknown: 'Unknown',
  },

  key: {
    heading: 'Dedup key',
    hint: 'The key is four components. When something that should have hit the cache missed, this is what you diff.',
    semanticKey: 'Semantic key',
    styleChecksum: 'Style checksum',
    variantKey: 'Variant key',
    specHash: 'Spec hash',
  },

  plan: {
    heading: 'The plan, before anything is spent',
    hint: 'This resolves without writing anything and without calling a provider, so it is safe to read as often as you like.',
    hits: 'Already in the library',
    misses: 'Would be generated',
    estimate: 'Estimated cost',
    free: 'Free',
    freeNote: 'Everything already exists. This run costs nothing.',
    requiresConfirmation: 'Needs explicit approval',
    reload: 'Resolve again',
    resolutions: 'Line by line',
    reason: 'Why',
    outcome: {
      'cache-hit': 'Cache hit',
      'variant-of-hit': 'Variant of a hit',
      miss: 'Miss',
      'blocked-by-budget': 'Blocked by budget',
    },
    unavailable: 'The API does not serve the library estimate yet.',
  },

  produce: {
    heading: 'Produce chain',
    hint: 'Eight steps, in the order the engine runs them.',
    stepOf: 'Step {index} of {total}',
    stoppedAt: 'Stopped at {step}',
    complete: 'All eight steps completed.',
    diagnosis: 'What the engine said',
    spent: 'This take cost {amount}',
    duration: '{ms} ms',
    step: {
      generate: 'Generate',
      matte: 'Matte',
      split: 'Split parts',
      score: 'Quality gate',
      rig: 'Fit rig',
      clips: 'Derive clips',
      bake: 'Bake sheet',
      register: 'Register',
    },
    outcome: {
      ran: 'Ran',
      resumed: 'Resumed from a checkpoint',
      failed: 'Failed',
      'not-reached': 'Never reached',
    },
  },

  incomplete: {
    heading: 'Takes that never registered',
    hint: 'These are not assets, but they did happen and they did cost money. Each one says where it stopped.',
    none: 'Every take registered.',
  },

  detail: {
    close: 'Close the detail panel',
    heading: 'Asset detail',
    provenance: 'Provenance',
    source: 'Source',
    model: 'Model',
    seed: 'Seed',
    promptHash: 'Prompt hash',
    cost: 'Cost',
    created: 'Created',
    parents: 'Derived from',
    description: 'Description',
    archetype: 'Archetype',
    tags: 'Tags',
  },

  versions: {
    heading: 'Versions',
    hint: 'A new take is always appended. No version is ever overwritten.',
    ordinal: 'Version {ordinal}',
    current: 'Current',
    select: 'Show version {ordinal}',
    cost: 'Cost {amount}',
    none: 'No version has been registered yet.',
  },

  parts: {
    heading: 'Parts',
    hint: 'Transparent layers with a z-order. The rig binds to these.',
    name: 'Name',
    role: 'Role',
    zOrder: 'z-order',
    coverage: 'Alpha coverage',
    deformable: 'Mesh',
    size: 'Size',
    none: 'No parts have been split out yet.',
    lowCoverage: 'Low coverage',
  },

  rig: {
    heading: 'Rig',
    template: 'Template',
    bones: 'Bones',
    meshes: 'Meshes',
    anchors: 'Anchors',
    ikChains: 'IK chains',
    root: 'Root',
    childOf: 'Child of {parent}',
    binds: 'Binds {count} parts',
    none: 'This version has no rig yet.',
  },

  clips: {
    heading: 'Clips',
    hint: 'Motion is computed on the rig, so more seconds cost nothing.',
    name: 'Name',
    duration: 'Duration',
    fps: 'fps',
    loop: 'Loop',
    source: 'Source',
    baked: 'Baked',
    notBaked: 'Not baked',
    seconds: '{value}s',
    none: 'No clips have been derived yet.',
  },

  variants: {
    heading: 'Variants',
    hint: 'A variant is an edit, not a new generation: only the named parts change.',
    replaces: 'Replaces: {parts}',
    none: 'No variants have been made.',
  },

  scores: {
    heading: 'Quality scores',
    styleMatch: 'Style match',
    alphaCleanliness: 'Alpha cleanliness',
    silhouetteReadability: 'Silhouette readability',
    identityMatch: 'Identity match',
    partCompleteness: 'Part completeness',
    overall: 'Overall',
    none: 'This version was not scored.',
  },

  regenerate: {
    open: 'Regenerate this asset',
    title: 'Generate a new version',
    lead: 'This appends a new version to {label} and spends money.',
    keepsPrevious: 'Version {ordinal} is untouched and stays openable.',
    reasonLabel: 'Reason',
    reasonRequired: 'Without a reason chosen, this button does nothing.',
    reason: {
      'new-take': 'New take',
      'style-changed': 'Style changed',
      'quality-reject': 'Quality rejected',
      'spec-changed': 'Spec changed',
      'manual-override': 'Manual override',
    },
    reasonHint: {
      'new-take': 'Same spec, another roll.',
      'style-changed': 'The style bible has a new lock and this asset no longer matches it.',
      'quality-reject': 'The quality scores are below the floor.',
      'spec-changed': 'The description or the part list has changed.',
      'manual-override': 'A reason not on this list. Say it in the note.',
    },
    note: 'Note',
    noteHint: 'Optional. Recorded in the new version’s provenance.',
    estimate: 'Estimated cost before it runs: {amount}',
    confirm: 'Generate a new version',
    cancel: 'Cancel',
    sending: 'Sending…',
    failed: 'The regeneration was refused.',
    appended: 'Version {ordinal} appended',
    appendedBody: 'The new version is registered and the previous one is exactly where it was.',
    previousStill: 'Previous version: {id}',
    newVersion: 'New version: {id}',
  },
};
