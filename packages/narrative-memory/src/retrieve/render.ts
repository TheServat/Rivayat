/**
 * Turning graph objects into the sentences a prompt actually carries.
 *
 * Kept apart from the retriever because these are the strings the token budget is spent
 * on, and because they are the only place the prompt's *wording* lives. A renderer that
 * grows an extra line costs every scene in the series that many tokens, which is a thing
 * worth being able to see in one file and diff in one review.
 *
 * Every renderer is a pure function of its argument. Nothing consults the clock, and
 * nothing depends on which order the caller happened to walk the graph in.
 */

import type {
  Entity,
  EpisodeSummary,
  EpistemicView,
  Fact,
  KnownFact,
  OpenLoop,
  Relation,
  SeriesSummary,
} from '@rv/contracts';

export function renderPremise(summary: SeriesSummary): string {
  const lines = [`PREMISE: ${summary.premise}`];
  if (summary.themes.length > 0) lines.push(`Themes: ${summary.themes.join(', ')}`);
  lines.push(`Tone: ${summary.toneNote}`);
  for (const rule of summary.rulesOfTheWorld) lines.push(`Rule of the world: ${rule}`);
  return lines.join('\n');
}

export function renderEpisodeOutline(summary: EpisodeSummary): string {
  const lines = [
    `EPISODE ${String(summary.index)} - ${summary.title}`,
    `Logline: ${summary.logline}`,
    `Synopsis: ${summary.synopsis}`,
  ];
  for (const beat of summary.beats) lines.push(`- ${beat}`);
  return lines.join('\n');
}

/**
 * A character sheet at the density a scene writer needs.
 *
 * Not the whole `CharacterPayload`: the full sheet is several thousand tokens and would
 * consume a whole budget for four characters. What is kept is what changes how a line
 * sounds - the dramatic engine, the voice, and the silhouette - and what is dropped is
 * everything the *asset* pipeline needs and the writer does not.
 */
export function renderEntitySheet(entity: Entity): string {
  const head = `${entity.canonicalName} (${entity.kind}, ${entity.importance})`;
  const lines = [head, entity.summary];
  if (entity.aliases.length > 0) lines.push(`Also called: ${entity.aliases.join(', ')}`);
  if (entity.kind === 'character') {
    const { psych, voice, visual, identity } = entity.payload;
    lines.push(
      `Age ${identity.age}; ${identity.occupation}, of ${identity.origin}.`,
      `Wants ${psych.want}. Needs ${psych.need}. Wounded by ${psych.wound}. Believes the lie: ${psych.lie}.`,
      `Voice: ${voice.register}, ${voice.verbosity}, ${voice.sentenceRhythm}.`,
      `Silhouette: ${visual.silhouetteNote}`,
    );
  }
  return lines.join('\n');
}

/**
 * The POV character's view, and only the parts of it that belong in a prompt.
 *
 * `blindSpots` is deliberately excluded. The schema says so - "never put these in the
 * prompt as facts" - and the reason is the whole point of the epistemic layer: the
 * blind spots are what the *audience* knows and the character does not, so handing them
 * to the writer reintroduces exactly the failure the view exists to prevent.
 */
export function renderEpistemicView(view: EpistemicView, name: string): string {
  const lines = [`WHAT ${name.toUpperCase()} KNOWS (write only from inside this):`];
  appendBeliefs(lines, 'Holds as true', view.knows);
  appendBeliefs(lines, 'Believes, wrongly', view.believesFalsely);
  appendBeliefs(lines, 'Suspects', view.suspects);
  if (lines.length === 1) lines.push('- Nothing yet. They walk in blind.');
  if (view.truncated) lines.push('- (view truncated: they know more than fits here)');
  return lines.join('\n');
}

function appendBeliefs(lines: string[], heading: string, facts: readonly KnownFact[]): void {
  if (facts.length === 0) return;
  lines.push(`${heading}:`);
  for (const fact of facts) lines.push(`- ${fact.fact} (via ${fact.via})`);
}

export function renderOpenLoop(loop: OpenLoop): string {
  return `UNPAID SETUP: ${loop.setup} — the audience is owed: ${loop.promise}`;
}

export function renderRelation(relation: Relation): string {
  return relation.fact;
}

/**
 * A stored fact's prompt text.
 *
 * A `relation` fact has no text of its own - the sentence lives on the edge, and copying
 * it onto the fact would create two spellings that drift the first time an author edits
 * one (`fact.ts`). So the resolver is handed the edge and returns its sentence.
 */
export function renderFact(fact: Fact, relation: Relation | undefined): string | undefined {
  switch (fact.content.kind) {
    case 'relation':
      return relation === undefined ? undefined : renderRelation(relation);
    case 'statement':
    case 'summary':
      return fact.content.text;
  }
}
