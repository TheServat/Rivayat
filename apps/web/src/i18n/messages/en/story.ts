/**
 * English messages for the Story screen. Mirror of `../fa/story.ts`.
 *
 * Typed through `MessageSchema`, which is inferred from the Persian catalogue, so
 * this file cannot silently fall behind it.
 */
export default {
  title: 'Story',
  subtitle: 'An idea becomes a tree of seasons, episodes, acts, sequences, scenes and beats.',

  context: {
    project: 'Project',
    series: 'Series',
    chooseSeries: 'Choose a series',
    noSeries: 'This project has no series yet.',
    premise: 'Series premise',
  },

  empty: {
    lead: 'No story tree has been built yet.',
    hint: 'Write your idea in one paragraph. Building starts at the root and descends exactly one level at a time.',
    ideaLabel: 'Series idea',
    ideaHint: 'One paragraph: who wants what, and what is in the way.',
    start: 'Build the first level',
  },

  loading: {
    tree: 'Loading the story tree…',
  },

  levels: {
    series: 'Series',
    season: 'Season',
    episode: 'Episode',
    act: 'Act',
    sequence: 'Sequence',
    scene: 'Scene',
    beat: 'Beat',
  },

  tree: {
    heading: 'Story tree',
    ariaLabel: 'Story tree, from series down to beat',
    plannedSummary: 'What the level above asked for',
    summary: 'What this node became',
    childCount: 'No children | One child | {count} children',
    expandNext: 'Build the next level: {level}',
    expandNextHint:
      'Each build descends one level and binds every child to what its parent asked for. That is why there is no "regenerate everything" button — skipping a level is exactly what breaks the story.',
    complete: 'All seven levels exist.',
    disclose: 'Show or hide what is under {title}',
    selectNode: 'Open {title}',
    selected: 'Open node',
    noSelection: 'Choose a node in the tree and it opens here.',
  },

  status: {
    label: 'Status',
    planned: 'Planned',
    expanded: 'Built',
    stale: 'Stale',
    generating: 'Building',
    staleHint: 'This node’s parent was edited after it was written; its own text is untouched.',
  },

  stream: {
    heading: 'Building',
    level: 'Level {level}',
    building: 'Writing {level}…',
    done: '{level} is ready.',
    progress: '{done} of {total} levels',
    cancel: 'Stop',
    cancelled: 'Building stopped. Every level that finished stays where it is.',
    keepReading: 'You can open and read the finished nodes while the rest arrives.',
  },

  node: {
    heading: 'Selected node',
    titleLabel: 'Title',
    summaryLabel: 'Node text',
    edit: 'Edit',
    cancel: 'Cancel',
    review: 'Review what this edit affects',
    saving: 'Saving…',
    saved: 'The edit was saved.',
    saveFailed: 'The edit could not be saved.',
    unchanged: 'Nothing has changed.',
    regenerate: 'Regenerate this node only',
    regenerateHint: 'Only this node’s subtree is rebuilt; its siblings are left alone.',
    save: 'Save the edit',
    regenerateEstimate: 'Estimated from what it cost last time: {amount}',
    regenerateConfirm: 'Rebuild it',
    history: 'Version history',
    historyEmpty: 'No previous version has been recorded yet.',
    historyEntry: 'Version {ordinal}',
    restore: 'Restore this version',
  },

  provenance: {
    heading: 'Who wrote this',
    role: 'Role',
    model: 'Model',
    cost: 'Cost',
    at: 'When',
    handwritten: 'Written by the author',
    notGenerated: 'Not generated yet',
  },

  impact: {
    heading: 'What this edit affects',
    none: 'This node has no children, so the edit affects nothing else.',
    affects: 'There are {count} children under this node.',
    levels: 'Levels affected: {levels}',
    stages: 'Stages that go stale: {from} onward',
    choose: 'What happens to the children',
    keep: 'Keep the children',
    keepHint:
      'Their text is left exactly as it is and only marked stale. It costs nothing, and you can rebuild them one at a time whenever you want.',
    reexpand: 'Rebuild the children',
    reexpandHint:
      'The subtree is discarded and rewritten from the new text. The previous version stays in the history.',
    costDelta: 'Estimated cost: {amount}',
    costNone: 'Estimated cost: nothing',
    confirmKeep: 'Save and keep the children',
    confirmReexpand: 'Save and rebuild the children',
    back: 'Back to editing',
  },

  bindings: {
    heading: 'Which model writes which part',
    hint: 'Every stage has its own model. A strong one for structure and a cheap one for the read-through is a normal thing to want mid-draft.',
    role: 'Role',
    stage: 'Stage',
    model: 'Model',
    price: 'Rate at this binding',
    tier: 'Quality tier',
    free: 'Free',
    router: 'Let the router choose',
    unknownPrice: 'Price not published',
    layer: 'Writing to the {layer} layer',
    readOnly: 'This option cannot be changed from the interface.',
    save: 'Save the model choices',
    saving: 'Saving…',
    saved: 'The model choices were saved.',
    unsaved: 'One unsaved change | {count} unsaved changes',
    loadFailed: 'The model list could not be loaded.',
    roles: {
      producer: 'Producer',
      screenwriter: 'Screenwriter',
      'art-director': 'Art director',
      director: 'Director',
      actor: 'Actor',
      'continuity-editor': 'Continuity editor',
    },
    roleHelp: {
      producer: 'Reads the idea and fixes the scope.',
      screenwriter: 'Structure: acts, sequences, scenes and beats.',
      'art-director': 'How the cast looks, and the prompt behind each state.',
      director: 'Reconciles separate performances into one scene.',
      actor: 'One per character, bound to that character’s voice.',
      'continuity-editor': 'Finds contradictions with aired canon.',
    },
    stages: {
      intake: 'Intake',
      story: 'Story',
      cast: 'Cast',
      sequence: 'Sequence',
    },
  },

  errors: {
    treeFailed: 'The story tree could not be loaded.',
    seriesFailed: 'The series list could not be loaded.',
    expandFailed: 'The next level could not be built.',
    notImplemented: 'The server has not built this part yet.',
    notImplementedHint:
      'The interface is ready, but the server has no {path} route. Until that route exists the story tree cannot be read or written.',
  },
};
