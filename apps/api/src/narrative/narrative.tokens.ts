/**
 * Tokens for the narrative graph surface. Same standing as `story/story.tokens.ts`:
 * these are services, not ports, so they stay out of the registry `app.spec.ts` counts.
 */

/** `NarrativeGraphStore` - the two tables, as a `NarrativeGraph`. */
export const NARRATIVE_GRAPH_STORE = 'NARRATIVE_GRAPH_STORE';
/** `SnapshotService` - the graph, the two sliders' stops, and one viewer's head. */
export const SNAPSHOT_SERVICE = 'SNAPSHOT_SERVICE';
