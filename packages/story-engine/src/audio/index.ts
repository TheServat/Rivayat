/**
 * The audio side of the story engine: who speaks, how, and when.
 *
 * Three files, in the order the pipeline uses them: a character sheet becomes a voice, a
 * belief graph becomes a stance, and a shot list becomes a scored timeline.
 */

export type { DeriveVoiceOptions } from './voice-casting';
export { deriveVoiceProfile } from './voice-casting';

export type { SpeakerPosition } from './line-stance';
export { speakerPosition, stanceFor } from './line-stance';

export type {
  CompileMarker,
  CompileAudioInput,
  CompileIssue,
  CompiledAudio,
} from './compile-audio-timeline';
export { compileAudioTimeline } from './compile-audio-timeline';
