/**
 * English messages for the Render and delivery screen. Mirror of `../fa/render.ts`.
 *
 * Typed through `MessageSchema`, which is inferred from the Persian catalogue, so
 * this file cannot silently fall behind it.
 */
export default {
  title: 'Render and delivery',
  subtitle: 'One composition, seven formats - each with its own safe area.',

  project: {
    label: 'Project',
    choose: 'Choose a project',
    empty: 'No project has been created yet.',
    emptyHint: 'Create a project first to see its delivery runs and what they cost.',
  },

  targets: {
    heading: 'Delivery targets',
    lead: 'Each target is a crop of the same composition. The grey frame is what gets encoded; the gold frame is the part the platform will not cover with its own interface.',
    count:
      'No target selected | One of {total} targets selected | {count} of {total} targets selected',
    selectAll: 'Select all',
    clearAll: 'Clear all',
    choose: 'Deliver to {format}',
    size: '{width} by {height} pixels',
    ratio: '{ratio} ratio',
    encode: '{codec} in {container}, {fps} fps',
    bitrate: '{min} to {max} Mbps',
    encodeLabel: 'Encoding',
    allowed: 'The platform accepts {codecs}',
    limitLabel: 'Length limit',
    limit: 'Up to {duration}',
    noLimit: 'No length limit',
    verified: 'Platform specs verified on 23 August 2026.',
  },

  safeArea: {
    label: 'Safe area',
    size: '{width} by {height} pixels',
    share: '{percent} of the frame',
    whole: 'The whole frame is safe',
    explain: 'Anything outside this box can end up behind the platform’s own buttons and captions.',
  },

  chrome: {
    label: 'Covered by the platform',
    none: 'This platform puts nothing over the frame.',
    share: 'covers {percent} of the frame',
    zones: {
      top: 'Top bar',
      captions: 'Caption rail',
      actions: 'Action rail',
    },
  },

  legend: {
    heading: 'Key',
    frame: 'Delivered frame',
    safeArea: 'Safe area',
    chrome: 'Platform interface',
    composition: 'Composition',
    focus: 'Focus target',
  },

  reframe: {
    label: 'Reframing',
    unplanned: 'Framing not solved yet',
    unplannedHint:
      'Framing is solved once a composition has been picked for delivery. Until then these cards show the platform spec only.',
    strategy: {
      crop: 'Fixed crop',
      panScan: 'Crop follows the subject',
      letterbox: 'Bars top and bottom',
      pillarbox: 'Bars either side',
      reflow: 'Layout moved',
    },
    explain: {
      crop: 'This crop keeps the focus inside the safe area.',
      panScan: 'The crop travels during the shot so the subject stays inside the safe area.',
      letterbox:
        'No crop could hold the focus, so the whole frame is kept with bars top and bottom.',
      pillarbox: 'No crop could hold the focus, so the whole frame is kept with bars either side.',
      reflow: 'Layout elements were moved for this format instead of moving the camera.',
    },
    held: 'Focus stays inside the safe area',
    missed: 'Focus falls outside the safe area',
    review: 'Needs a look before publishing',
    shot: 'Shot {shot}',
  },

  spec: {
    label: 'Checked against the platform spec',
    passed: 'Passed',
    failed: 'Failed',
    awaiting: 'Not checked yet',
    awaitingHint:
      'Delivered files are checked against their platform spec after rendering; there is nothing to check yet.',
  },

  run: {
    heading: 'Delivery run',
    lead: 'A render takes minutes. You do not have to wait here.',
    picker: 'Run',
    none: 'No run has been recorded for this project yet.',
    noneHint: 'When an episode is ready to deliver, its run is watched and controlled here.',
    started: 'Started {when}',
    finished: 'Finished {when}',
    elapsed: 'Elapsed',
    seed: 'Seed {seed}',
    stagesHeading: 'Stages',
    progress: '{percent} done',
    artifacts: 'What this run wrote to disk',
    noArtifacts: 'This run has not written a file yet.',
    issues: 'Reported events',
    cancel: 'Cancel run',
    cancelling: 'Cancelling…',
    resume: 'Resume from checkpoint',
    resuming: 'Resuming…',
    resumeHint:
      'Continues from the first stage with no checkpoint. Frames already written are not drawn again.',
    resumeBlocked: 'A cancelled or successful run cannot be resumed.',
    failedNote: 'This run stopped on its own. Resuming continues from its last checkpoint.',
    cancelledNote:
      'You stopped this run. A new run continues from the frames it already wrote, so nothing is drawn twice.',
    recoverHint:
      'If the render stopped without finishing - the machine restarted, say - resuming picks it up from its last checkpoint.',
    checkpoint: 'Has a checkpoint',
    survivable:
      'You can close this page. The run continues on the server and this address brings you back to it.',
    liveLabel: 'Live stream',
    live: {
      idle: 'Not following',
      connecting: 'Connecting…',
      open: 'Live',
      reconnecting: 'Dropped, reconnecting…',
      failed: 'Live updates unavailable',
    },
    errorCode: 'Error code {code}',
  },

  status: {
    queued: 'Queued',
    running: 'Running',
    paused: 'Paused',
    succeeded: 'Succeeded',
    failed: 'Failed',
    cancelled: 'Cancelled',
  },

  stage: {
    intake: 'Intake',
    style: 'Style',
    story: 'Story',
    cast: 'Cast',
    world: 'World',
    resolve: 'Resolve assets',
    produce: 'Produce assets',
    sequence: 'Shots',
    choreograph: 'Motion',
    preview: 'Preview',
    render: 'Render',
    deliver: 'Deliver',
  },

  cost: {
    heading: 'Cost',
    lead: 'What a run costs depends on how long the episode is. What matters across a series is what a minute costs.',
    perMinute: 'Cost per delivered minute',
    perMinuteNone: 'No minutes delivered yet',
    total: 'Project total',
    delivered: 'Video delivered',
    deliveredNone: 'None',
    runsHeading: 'Runs, and what each one cost',
    columns: {
      run: 'Run',
      status: 'Status',
      delivered: 'Delivered',
      cost: 'Cost',
      perMinute: 'Per minute',
    },
    budget: {
      label: 'Ceiling for this run',
      spent: '{spent} of {ceiling}',
      none: 'No separate ceiling was set for this run.',
      over: 'Over the ceiling.',
      remaining: '{amount} left',
    },
    free: 'Free',
  },

  // Lower case: these are only ever interpolated into another sentence, and "Up to One
  // minute" is what a capital in a plural form buys you.
  duration: {
    seconds: 'no time | one second | {count} seconds',
    minutes: 'no time | one minute | {count} minutes',
  },

  errors: {
    formats: 'The delivery formats could not be loaded.',
    runs: 'The runs could not be loaded.',
    cost: 'The cost report could not be loaded.',
  },
};
