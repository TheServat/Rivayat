/**
 * Audio: the emotion vocabulary, the casting, the timeline, and the narrator's page.
 *
 * Barrel order follows the dependency order: what a line sounds like, who says it, when
 * it happens, and finally the two things that read the timeline - the engine catalogue
 * and the script a person performs from.
 */

export * from './emotion';
export * from './voice';
export * from './timeline';
export * from './speech-model';
export * from './narration';
