/**
 * English messages for the Style Lab screen. Mirror of `../fa/style-lab.ts`.
 *
 * Typed through `MessageSchema`, which is inferred from the Persian catalogue, so
 * this file cannot silently fall behind it.
 */
export default {
  title: 'Style Lab',
  subtitle: 'Choose and lock the style before anything else - how it looks and how it moves.',
  loading: 'Fetching styles…',

  state: {
    label: 'Style state',
    none: 'No style chosen yet',
    draft: 'Draft',
    locked: 'Locked',
  },

  steps: {
    choose: 'Choose a style',
    chooseHint: 'Eleven ready-made styles. Every card moves the way that style moves.',
  },

  gallery: {
    label: 'Ready-made styles',
    chosen: 'Chosen',
    adopting: 'Building the style draft…',
  },

  motion: {
    // Not "frame rate": a style at 24 fps held on 3s shows eight drawings a second, and
    // eight is the number that decides whether it reads as animated or as interpolated.
    fps: 'Drawings a second',
    step: 'Frame stepping',
    stepMode: {
      smooth: 'Smooth',
      'on-2s': 'On 2s',
      'on-3s': 'On 3s',
      'on-4s': 'On 4s',
    },
    tempo: 'Tempo',
    tempoValue: '×{value}',
    boil: 'Line boil',
    boilOn: '{hz} Hz',
    boilOff: 'None',
    easing: 'Easing curve',
    easingNamed: '“{name}”',
  },

  playback: {
    label: 'How motion is shown',
    play: 'Play',
    step: 'Step',
    playHint: 'Each card plays its own motion loop.',
    stepHint: 'Motion is paused; advance the frames one at a time.',
    frame: 'Frame {index} of {total}',
    previous: 'Previous frame',
    next: 'Next frame',
    reduced: 'Your system asked for reduced motion, so these step instead of playing.',
  },

  palette: {
    swatch: '{name} - {hex}',
  },

  checksum: {
    label: 'Style fingerprint',
    none: 'Not made yet',
    pending: 'Settled when you lock',
    hint: 'Every asset’s dedup key is derived from this value.',
  },

  probe: {
    heading: 'Probe sheet',
    hint: 'Four fixed subjects: a figure, a tree, a prop and a sky. Always the same four, so two styles are genuinely comparable.',
    lane: 'Image lane',
    laneFree: 'Local',
    laneFreeHint: 'On your own graphics card. Free and unlimited.',
    lanePaid: 'Cloud',
    lanePaidHint: 'A higher-quality cloud model. Every image costs money.',
    recommended: 'Recommended',
    estimate: 'Estimate, before it runs',
    estimateLine: '{images} images on the {lane} lane',
    estimateFree: 'Free',
    run: 'Run the probe sheet',
    running: 'Making four images…',
    again: 'Run it again',
    sheetHeading: 'Probe result',
    ranOn: 'On the {lane} lane',
    total: 'Cost of this sheet',
    unpriced: 'Price unknown',
    needsStyle: 'Choose a style first.',
    tileAlt: '{subject} in the {style} style',
  },

  lock: {
    heading: 'Lock',
    hint: 'The only irreversible action on this screen.',
    action: 'Lock the style',
    locking: 'Locking…',
    locked: 'This style is locked.',
    lockedAt: 'Locked {when}',
    needsStyle: 'Choose a style first.',
    confirmTitle: 'Lock this style?',
    confirmBody:
      'The style’s fingerprint is frozen, and every asset made from now on derives its dedup key from it. Changing style later forks the asset library instead of reusing any of it.',
    confirmName: 'Locking: {name}',
    confirm: 'Yes, lock it',
    forProject: 'For {project}',
    noProject: 'No project selected, so this lock will not be recorded on one.',
    detached: 'The style is locked, but this project does not point at it yet.',
    attach: 'Point the project at it',
    attaching: 'Attaching…',
  },

  empty: {
    heading: 'The shelf is empty.',
    body: 'Style Lab is fed by the server’s list of ready-made styles, and that list came back with nothing in it.',
  },
};
