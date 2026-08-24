/**
 * English messages for the Timeline screen. Mirror of `../fa/timeline.ts`.
 *
 * Typed through `MessageSchema`, which is inferred from the Persian catalogue, so
 * this file cannot silently fall behind it.
 */
export default {
  title: 'Timeline',
  subtitle: 'See and change the motion. What you see here is what renders.',

  loading: 'Reading the animation document…',

  empty: {
    heading: 'There is no motion to edit yet.',
    body: 'Once a shot is compiled into an Animation IR it opens here: tracks, keyframes, behaviours and the camera.',
  },

  unavailable: {
    heading: 'This part is not built on the server yet.',
    body: 'The API has no route that serves an Animation IR. The screen is ready and will work the moment one lands.',
    endpoint: 'Missing route: {method} {path}',
    story: 'Delivered by: {story}',
  },

  picker: {
    label: 'Animation',
  },

  agreement: {
    heading: 'The preview is what renders',
    body: 'This preview reads evaluate(ir, t) from anim-engine directly, the same function the renderer, the sheet baker and the Lottie exporter use. There is no approximated curve anywhere in it.',
  },

  transport: {
    label: 'Playback controls',
    play: 'Play',
    pause: 'Pause',
    toStart: 'To the start',
    toEnd: 'To the end',
    back: 'Back one frame',
    forward: 'Forward one frame',
    loop: 'Loop',
    time: 'Time',
    frame: 'Frame {frame} of {total}',
    fps: '{fps} fps',
    duration: '{seconds}s long',
  },

  scrub: {
    label: 'Playhead',
    hint: 'Arrow keys move one frame, Shift moves ten, Home and End jump to the ends.',
    position: 'Frame {frame} of {total}, {seconds}s',
    rtlNote:
      'Time runs right to left in Persian: the right arrow goes back and the left arrow goes forward.',
    ltrNote: 'Time runs left to right: the right arrow goes forward and the left arrow goes back.',
  },

  stage: {
    label: 'Scene preview',
    scene: 'Scene space',
    sceneSpace: '{width} by {height}',
    camera: 'Camera',
    zoom: 'Zoom {value}',
    nodes: 'Nothing to draw | One drawable node | {count} drawable nodes',
    origin: 'Scene space has its origin at the centre of the canvas, exactly as the renderer does.',
    noCanvas: 'This browser gave no 2D context. The frame values below are still correct.',
  },

  motion: {
    heading: 'Motion source',
    keyframe: 'Keyframes',
    'keyframe-over-procedural': 'Keyframes over a behaviour',
    'keyframe-with-procedural': 'Keyframes plus a behaviour',
    unknown: 'Unknown',
    consequence: {
      replaces:
        'The {behaviours} behaviour also drives this channel. This track is not additive, so a keyframe value replaces it.',
      sums: 'The {behaviours} behaviour also drives this channel. This track is additive, so a keyframe value sums with it.',
    },
  },

  tracks: {
    heading: 'Tracks',
    none: 'This animation has no hand keyframes; everything comes from procedural behaviours.',
    node: 'Node',
    channel: 'Channel',
    keyframes: 'No keyframes | One keyframe | {count} keyframes',
    ruler: 'Time ruler',
    markers: 'Markers',
    select: 'Select keyframe {index} on {channel}',
  },

  keyframe: {
    heading: 'Selected keyframe',
    none: 'Select a keyframe to edit it here.',
    time: 'Time in milliseconds',
    value: 'Value',
    easing: 'Easing out',
    hint: 'Drag it, or move it with the arrow keys. Each change is one operation and each one undoes.',
    at: 'at {ms} ms, value {value}',
  },

  easing: {
    none: 'Linear',
    named: 'Named curve: {name}',
    cubic: 'Custom bezier',
    stepped: 'Stepped, {steps} steps',
  },

  behaviour: {
    heading: 'Behaviours',
    none: 'This animation carries no procedural behaviour.',
    enabled: 'Enabled',
    weight: 'Weight',
    seed: 'Seed',
    select: 'Select the {kind} behaviour',
    onNode: 'on {node}',
    param: 'Parameter {name}',
  },

  behaviourKind: {
    wind: 'Wind',
    breathe: 'Breathe',
    blink: 'Blink',
    sway: 'Sway',
    'walk-cycle': 'Walk cycle',
    flap: 'Flap',
    orbit: 'Orbit',
    parallax: 'Parallax',
    boil: 'Boil',
    spring: 'Spring',
    'look-at': 'Look at',
    'follow-path': 'Follow path',
    'lip-sync': 'Lip sync',
  },

  markerKind: {
    beat: 'Beat',
    cut: 'Cut',
    dialogue: 'Dialogue',
    sfx: 'SFX',
    music: 'Music',
    custom: 'Custom',
  },

  history: {
    undo: 'Undo',
    redo: 'Redo',
    none: 'Nothing has been changed yet.',
    edits: 'No edits | One edit | {count} edits',
    unsaved: 'Not saved',
    unsavedHint:
      'The API has no route for IR operations yet, so these edits live on this page only.',
  },

  op: {
    moveKeyframe: 'Move keyframe',
    setEasing: 'Change easing',
    setBehaviourParam: 'Change a behaviour parameter',
  },

  refusal: {
    'unknown-track': 'No such track: {subject}',
    'unknown-keyframe': 'No such keyframe: {subject}',
    'unknown-behaviour': 'No such behaviour: {subject}',
    'unknown-param': 'That parameter cannot be changed on this behaviour: {subject}',
    'not-a-number': 'Not a usable number: {subject}',
    'out-of-order':
      'That would move the keyframe past its neighbour; the order in time has to hold: {subject}',
    'past-duration': 'That time is outside this animation: {subject}',
    'before-zero': 'Time cannot be negative: {subject}',
  },
};
