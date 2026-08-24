/**
 * What S1 records so the rest of the run can find the style it established.
 *
 * A run carries **one payload for every stage** - `PipelineRunner` hands each job
 * `state.payload` unchanged - so a run that starts at S1 cannot name in its payload the
 * bible S1 has not made yet. The run record is the channel that does carry it forward:
 * each stage runs as its own job and re-reads the run, so `context.run.stages` holds the
 * `kind:ref` strings the earlier stages produced.
 *
 * This is the same seam `render/composition-source.ts` uses for `composition:<sha256>`,
 * and it is a *fallback* here for the same reason it is there. A payload that names a
 * `styleBibleId` wins: a run that names its style is making a claim about which checksum
 * every asset key in it will contain, and silently substituting another one - even one
 * the same run made - would fork the library behind the operator's back.
 */

import { StyleBibleId } from '@rv/contracts';

import type { RunSummary } from '../application/resources';

/** How S1 names the bible it settled on. */
export const STYLE_BIBLE_ARTIFACT_PREFIX = 'style-bible:';

/**
 * The style bible an earlier stage of this run established, or `null`.
 *
 * The *last* one wins: a run that established a style twice - S1 re-run after an edit -
 * has two, and the later one is the style the rest of the run is about.
 */
export function upstreamStyleBibleId(run: RunSummary): StyleBibleId | null {
  let found: StyleBibleId | null = null;
  for (const stage of run.stages) {
    if (stage.status !== 'succeeded') continue;
    for (const artifact of stage.artifacts) {
      if (!artifact.startsWith(STYLE_BIBLE_ARTIFACT_PREFIX)) continue;
      // Parsed rather than sliced-and-trusted: the artifact list is prose-adjacent, and a
      // malformed id here would reach the produce stage as "no style bible is stored
      // under ..." instead of as a bad artifact.
      const parsed = StyleBibleId.safeParse(artifact.slice(STYLE_BIBLE_ARTIFACT_PREFIX.length));
      if (parsed.success) found = parsed.data;
    }
  }
  return found;
}
