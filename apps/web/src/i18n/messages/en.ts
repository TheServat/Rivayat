import type { MessageSchema } from './fa';

/**
 * English messages - the fallback locale.
 *
 * Typed as `MessageSchema` rather than left to inference. That single annotation is
 * what makes "a missing translation fails the build": omit a key and `vue-tsc` reports
 * it here, add one that Persian does not have and the excess-property check reports
 * that too. The runtime key-set test in `i18n.spec.ts` is the second net, for the case
 * where a catalogue is assembled dynamically.
 */
import assets from './en/assets';
import characters from './en/characters';
import render from './en/render';
import story from './en/story';
import styleLab from './en/style-lab';
import timeline from './en/timeline';

const en: MessageSchema = {
  app: {
    name: 'Rivayat',
    tagline: 'From an idea to an animated series',
  },

  nav: {
    label: 'Main sections',
    pipeline: 'The pipeline',
    studio: 'Studio',
    projects: 'Projects',
    styleLab: 'Style Lab',
    story: 'Story',
    characters: 'Characters',
    assets: 'Asset library',
    timeline: 'Timeline',
    render: 'Render and delivery',
    settings: 'Settings',
  },

  shell: {
    skipToContent: 'Skip to main content',
    mainContent: 'Main content',
    toolbar: 'Display options',
    transportFixture: 'Fixture data',
    transportFixtureHint:
      'This session is not connected to a server; every value is read from recorded fixtures.',
  },

  theme: {
    label: 'Theme',
    light: 'Light',
    dark: 'Dark',
    system: 'Match system',
  },

  locale: {
    label: 'Language',
    fa: 'فارسی',
    en: 'English',
  },

  common: {
    save: 'Save',
    saveAll: 'Save all changes',
    cancel: 'Cancel',
    discard: 'Discard changes',
    retry: 'Try again',
    reload: 'Reload',
    close: 'Close',
    search: 'Search',
    loading: 'Loading…',
    none: 'None',
    unknown: 'Unknown',
    optional: 'Optional',
    required: 'Required',
    yes: 'Yes',
    no: 'No',
    on: 'On',
    off: 'Off',
    open: 'Open',
    empty: 'Nothing to show',
  },

  errors: {
    title: 'Error',
    unexpected: 'Something unexpected went wrong.',
    network: 'Could not reach the server.',
    schemaMismatch: 'The server’s response did not match the data contract and was rejected.',
    schemaMismatchDetail: 'Invalid field: {path}',
    kind: {
      validation: 'The submitted data is not valid.',
      'not-found': 'What you asked for does not exist.',
      conflict: 'The state changed on the server.',
      unsupported: 'This capability is not available in the current configuration.',
      provider: 'An upstream provider failed.',
      timeout: 'The server took too long to answer.',
      'rate-limit': 'Too many requests; the provider asked us to slow down.',
      budget: 'This would exceed the configured spending limit.',
      cancelled: 'The operation was cancelled.',
      internal: 'Internal server error.',
    },
    serverDetail: 'Server report',
    code: 'Error code: {code}',
    retryable: 'Trying again may work.',
  },

  sse: {
    connecting: 'Connecting to the progress stream…',
    connected: 'Connected',
    reconnecting: 'Disconnected; retrying in {seconds}s',
    failed: 'Could not connect to the progress stream.',
  },

  projects: {
    title: 'Projects',
    subtitle: 'Each project owns a series, a style bible and an asset library.',
    emptyHint: 'Start the first one from a one-line idea.',
    columns: {
      name: 'Name',
      status: 'Status',
      episodes: 'Episodes',
      style: 'Style bible',
      spend: 'Total spend',
      updated: 'Last change',
    },
    styleLocked: 'Locked',
    styleUnlocked: 'Unlocked',
    styleAbsent: 'Not chosen',
    episodeCount: 'No episodes | One episode | {count} episodes',
    openProject: 'Open project {name}',
    noLogline: 'No idea written down yet',
    emptyTitle: 'This is where an idea becomes a series.',
    startAnother: 'Start the next idea here too.',
    totals: {
      label: 'Total',
      projects: 'One project | {count} projects',
      spend: 'Studio spend to date',
    },
    new: {
      action: 'New project',
      title: 'New project',
      intro: 'A name and a one-line idea is enough. Everything else starts from those two.',
      nameLabel: 'Project name',
      nameHint: 'Up to 120 characters.',
      ideaLabel: 'The idea',
      ideaHint: 'A sentence or two about what it is. You can expand it later.',
      ideaPlaceholder:
        'For instance: a mountain postman, one winter, a secret that must reach nobody.',
      submit: 'Create project',
      submitting: 'Creating…',
      created: 'Project “{name}” created.',
      nameRequired: 'Give it a name.',
      ideaRequired: 'Write a short sentence about the idea.',
      tooLong: 'That is longer than the field allows.',
      failed: 'The project could not be created.',
    },
  },

  settings: {
    title: 'Settings',
    subtitle:
      'Every option the code reads is here. This screen is generated from the setting registry, not hand-written.',
    search: 'Search settings',
    searchHint: 'Name, key or help text',
    noMatches: 'No setting matches that search.',
    dirtyCount: 'One unsaved change | {count} unsaved changes',
    unsaved: 'Unsaved',
    saved: 'Settings saved.',
    saveFailed: 'Saving failed.',
    keyLabel: 'Key: {key}',
    groups: {
      providers: 'Providers and keys',
      models: 'Per-stage model choice',
      image: 'Image lane',
      budget: 'Budget and cost ceilings',
      render: 'Rendering',
      delivery: 'Delivery formats',
      interface: 'Appearance and language',
      runtime: 'Runtime and paths',
    },
    editingLayer: 'Editing the {layer} layer',
    readOnly: 'Read-only',
    readOnlyHint:
      'This option lives only in the machine layer and cannot be changed from the interface. Edit it in the .env file.',
    envVariable: 'Environment variable: {name}',
    ignored: 'The {layer} layer stores an invalid value; the layer below it applies instead.',
    warnings: {
      title: 'Environment file warnings',
    },
    provenance: {
      label: 'Where this value comes from',
      default: 'Default',
      machine: 'Machine',
      global: 'Global',
      project: 'Project',
      run: 'Run',
      from: 'From the {layer} layer',
      overridden: 'Overridden at this layer.',
      inherited: 'Inherited from the {layer} layer.',
      shadowed: 'Set at this layer, but a more specific layer overrides it.',
    },
    scope: {
      label: 'Scope',
      machine: 'Machine',
      global: 'Global',
      project: 'Project',
      run: 'Run',
    },
    clearOverride: 'Clear override and inherit',
    clearOverrideHint: 'Removes this layer’s override so the value below it applies again.',
    requiresRestart: 'Needs a restart',
    requiresRestartHint: 'This option takes effect only after the server restarts.',
    invalid: 'That value is not valid.',
    secret: {
      present: 'Set',
      absent: 'Not set',
      never: 'A secret’s value is never shown.',
      set: 'Set a new value',
      clear: 'Clear',
      placeholder: 'Enter a new value',
    },
    modelPicker: {
      provider: 'Provider',
      model: 'Model',
      free: 'Free',
      capabilities: 'Capabilities',
      choose: 'Choose a model',
      router: 'Let the router choose',
      custom: 'Custom model',
      customLabel: 'Custom model id',
      empty: 'The catalogue offers no model for this slot; enter an id by hand.',
    },
    multiSelect: {
      hint: 'Choose one or more.',
      min: 'At least {count} must be chosen.',
      max: 'No more than {count} can be chosen.',
    },
    json: {
      hint: 'Enter valid JSON.',
      invalid: 'That is not valid JSON.',
    },
    money: {
      hint: 'Amount in US dollars. Leave it empty for no ceiling at this layer.',
      nanoUsd: '${usd}',
      noCeiling: 'No ceiling',
    },
    slider: {
      value: 'Value: {value}',
    },
    loadFailed: 'The setting registry could not be loaded.',
  },

  placeholder: {
    badge: 'Not built yet',
    heading: 'This screen has not been implemented.',
    stage: 'Stage {index} of {total} in the pipeline',
    willContain: 'When it is, it will hold:',
    dependsOn: 'Depends on: {stories}',
    styleLab: {
      title: 'Style Lab',
      body: 'Preset browser, derive-a-style from reference images, the guided wizard, the probe sheet, and locking the style bible together with its checksum.',
    },
    story: {
      title: 'Story',
      body: 'The series tree down through season, episode, act, sequence, scene and beat; per-node editing, a version history drawer, and regenerating one subtree only.',
    },
    characters: {
      title: 'Characters',
      body: 'A sheet per character with psychology, voice, arc and motion signature, plus the expression, pose and wardrobe grids with each state’s prompt; and the entity graph with a story-time slider.',
    },
    assets: {
      title: 'Asset library',
      body: 'Browsing and semantic search over the registry, versions and variants, transparent parts with their z-order, rigs, clips, and the per-asset cost ledger.',
    },
    timeline: {
      title: 'Timeline',
      body: 'Track and keyframe editing over the Animation IR, behaviour parameters, markers, and the PixiJS player with deterministic scrubbing.',
    },
    render: {
      title: 'Render and delivery',
      body: 'A live preview per format with its safe-area overlay, a cost estimate before anything is spent, run monitoring over SSE with cancel and resume, and the list of delivered files.',
    },
  },

  notFound: {
    title: 'Page not found',
    body: 'That address does not lead to any screen.',
    backToProjects: 'Back to projects',
  },

  // One namespace per screen, each in its own file under `en/`. Screens are built by
  // different people at different times; a single catalogue is the file they all have to
  // edit at once, and the merge that follows loses somebody's keys.
  styleLab,
  story,
  characters,
  assets,
  timeline,
  render,
};

export default en;
