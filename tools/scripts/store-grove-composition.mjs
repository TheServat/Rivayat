/**
 * Put the grove scene into the composition store, through the API.
 *
 * The timeline screen needs something to open. The grove is the scene the renderer
 * already turns into the two mp4s in `workspace/demo`, so storing *that* IR means the
 * screen shows the animation the video was made from rather than a fixture that resembles
 * one - and if the player and the renderer ever disagree, they disagree about a document
 * both of them have actually consumed.
 *
 * Posted over HTTP rather than written to the store directly, for the same reason the
 * studio is driven from the front: a path that only a script can take is a path nobody
 * has tested.
 */

import { buildGroveScene } from '../../apps/cli/src/commands/animate.ts';

const BASE = process.env.RV_API_BASE ?? 'http://127.0.0.1:3300/api';

const { ir } = buildGroveScene();

const response = await fetch(`${BASE}/compositions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ir, label: 'Grove at dusk' }),
});

const body = await response.json();
if (!response.ok) {
  console.error(`store failed: HTTP ${response.status}`);
  console.error(JSON.stringify(body, null, 2).slice(0, 600));
  process.exit(1);
}

console.log('stored:');
console.log(`  id         ${body.id ?? body.value?.id}`);
console.log(`  label      ${body.label ?? body.value?.label}`);
console.log(`  duration   ${body.durationMs ?? body.value?.durationMs} ms`);
console.log(`  nodes      ${body.nodeCount ?? body.value?.nodeCount}`);
