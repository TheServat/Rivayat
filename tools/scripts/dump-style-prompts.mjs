/**
 * What each of the eleven presets actually sends to a 77-token CLIP encoder.
 *
 * The style sweep needs to know what it is varying. `compilePositiveClause` emits
 * nineteen-odd clauses; `clip-77` keeps the first four, and those four are the whole
 * of the style signal SD 1.5 receives. Printing them is how a "the model cannot draw
 * this style" claim becomes checkable rather than asserted.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const pkg = (name) => pathToFileURL(join(ROOT, 'packages', name, 'src', 'index.ts')).href;

const { PRESET_DEFINITIONS, findPreset, materialiseStyleBible } = await import(pkg('style-engine'));
const { lock } = await import(pkg('core-domain'));
const { SystemClock, toIso, unwrap } = await import(pkg('shared-kernel'));
const { Ids } = await import(pkg('contracts'));

const clock = new SystemClock();
const ids = new Ids();

for (const def of PRESET_DEFINITIONS) {
  const preset = unwrap(findPreset(def.id));
  const style = unwrap(
    lock(
      materialiseStyleBible({ draft: preset.draft, id: ids.styleBible(), clock }),
      toIso(clock.now()),
    ),
  );
  const clauses = style.prompts.positive.split(', ');
  console.log(
    `\n=== ${def.id}  (medium ${style.visual.medium}, shading ${style.visual.shading.model}, line ${style.visual.line.present ? style.visual.line.weight : 'none'}) ===`,
  );
  console.log(`  clip-77 style : ${clauses.slice(0, 4).join(', ')}`);
  console.log(`  full  (${style.prompts.positive.length} ch): ${style.prompts.positive}`);
  console.log(`  negative      : ${style.prompts.negative}`);
  console.log(`  visual.negative: ${style.visual.negative.join(' | ')}`);
}

console.log('\n\n######## comfyui tag prompts (PromptFragments.byModel) ########');
for (const def of PRESET_DEFINITIONS) {
  const preset = unwrap(findPreset(def.id));
  const style = unwrap(
    lock(
      materialiseStyleBible({ draft: preset.draft, id: ids.styleBible(), clock }),
      toIso(clock.now()),
    ),
  );
  const keys = Object.keys(style.prompts.byModel);
  const tag = style.prompts.byModel[keys[0]];
  console.log(`\n${def.id}  [${keys.join(' ')}]`);
  console.log(`  (${tag.length} ch) ${tag}`);
}
