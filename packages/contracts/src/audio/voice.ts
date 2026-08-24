/**
 * Who says a line, and in what voice - decided once per series, not once per line.
 *
 * The owner's brief for this layer is one sentence: **"the narrator is me, the
 * characters are AI."** That sentence is a *casting* decision, and casting is exactly
 * what this file models. {@link VoiceCasting.narratorRef} names the entity whose lines
 * are the owner's; every other speaker is bound to a synthetic voice. Downstream, the
 * split is total and mechanical: a narrator line becomes a paragraph on a page a human
 * reads, a character line becomes a metered provider call. Nothing else in the system
 * has to know which is which.
 *
 * Modelling narration as *an entity that speaks* rather than as a new field on `Shot`
 * is deliberate. `Shot.dialogue` already carries lines with a `speakerRef`, a subtext
 * and a `DeliveryNote`; narration needs all three and nothing more. A parallel
 * `Shot.narration` array would duplicate the shape, and the first time someone wanted
 * the narrator to be sardonic about a character they would find the field they needed
 * on the other type.
 *
 * ## Why the voice is derived and not dialled
 *
 * `CharacterVoice` in `narrative/entity.ts` already says how a character speaks -
 * register, verbosity, rhythm, humour, what their silence means - and its docstring
 * says why it exists: "the most reliable tell of LLM-written serial fiction is that
 * every character speaks in the same competent middle register." A separate set of TTS
 * knobs tuned by hand would re-introduce exactly that failure one layer down, and the
 * sheet and the voice would drift apart the first time either was edited. So
 * {@link VoiceProfile} is *derived* from the sheet (in `@rv/story-engine`) and the
 * derivation is the only sanctioned way to obtain one.
 */

import { z } from 'zod';

import {
  Label,
  Millis,
  NonEmptyString,
  NonNegativeInt,
  Prose,
  Sha256Hex,
  SignedUnit,
  Unit01,
} from '../primitives/common';
import { EntityId } from '../primitives/ids';

/**
 * A BCP-47 language tag, loosely.
 *
 * Loose on purpose: the vendors disagree about what they accept - Chatterbox takes a
 * bare ISO-639-1 `language_id`, ElevenLabs takes an ISO-639-1 `language_code`, Higgs
 * infers from the text - and a strict registry check here would reject a tag one of
 * them wants. What is enforced is the shape, so `primarySubtag` can be taken safely.
 */
export const LanguageTag = z
  .string()
  .regex(
    /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/,
    'expected a BCP-47 language tag, e.g. "fa" or "fa-IR"',
  )
  .describe('BCP-47 language tag, e.g. "fa", "fa-IR", "en-GB"');
export type LanguageTag = z.infer<typeof LanguageTag>;

/** The language part of a tag, which is the part every engine agrees on. */
export function primarySubtag(tag: LanguageTag): string {
  const separator = tag.indexOf('-');
  return separator === -1 ? tag : tag.slice(0, separator);
}

/** Persian, the series language. Named because four files would otherwise spell it. */
export const PERSIAN: LanguageTag = 'fa';

// -- the exemplar -------------------------------------------------------------

/**
 * A recorded clip that *is* the voice, for the engines that clone rather than select.
 *
 * Two of the three engines take one of these and there is no substitute for it:
 * Chatterbox has no preset voices worth the name and Higgs's zero-shot cloning is its
 * headline feature. Addressed by content hash rather than by path because the clip is a
 * CAS blob like every other binary in the system, and because a voice that silently
 * changed under a series would be the worst continuity bug available.
 *
 * `transcript` is not optional decoration. Higgs's model card states it plainly -
 * "supplying the reference transcript materially improves cloning fidelity" - so an
 * exemplar without one is a worse exemplar, and making the field required is the
 * cheapest way to stop that happening by omission.
 */
export const VoiceExemplar = z.strictObject({
  sha256: Sha256Hex.describe('Content address of the clip in the CAS.'),
  mimeType: NonEmptyString.max(80).describe('e.g. "audio/wav". Never inferred from the path.'),
  bytes: NonNegativeInt,
  durationMs: Millis.describe('Length of the clip. Cloning quality collapses below a few seconds.'),
  sampleRateHz: NonNegativeInt.describe(
    '0 when unknown; a real rate when the decoder reported one.',
  ),
  language: LanguageTag,
  transcript: Prose.describe(
    'Exactly what is said in the clip, verbatim. Improves cloning fidelity.',
  ),
  note: Prose.optional().describe('Where the clip came from and what consent covers it.'),
});
export type VoiceExemplar = z.infer<typeof VoiceExemplar>;

// -- the profile --------------------------------------------------------------

export const VOICE_ROLES = ['narrator', 'character'] as const;

/**
 * What this voice *is* in the story: the one telling it, or one of the people in it.
 *
 * A narrative function, and therefore what decides which of §27's tracks the lines land
 * on. Kept apart from {@link Performer}, which is the operational question of who makes
 * the sound. Conflating the two reads fine for the series the owner is making now -
 * where narrator means "the owner" - and breaks the first time a series has a synthetic
 * voice-over or a guest reads a part.
 */
export const VoiceRole = z.enum(VOICE_ROLES);
export type VoiceRole = z.infer<typeof VoiceRole>;

export const PERFORMERS = ['human', 'synthetic'] as const;

/**
 * Who makes the sound.
 *
 * The single field that splits the audio layer's two outputs. `human` lines are typeset
 * onto a page and never reach a network; `synthetic` lines are metered provider calls.
 * Everything downstream - cost estimation, the narrator's script, the mix - branches on
 * this and on nothing else.
 */
export const Performer = z.enum(PERFORMERS);
export type Performer = z.infer<typeof Performer>;

/**
 * How a voice should be bound to whatever engine is installed, without naming one.
 *
 * A preset id and an exemplar are the two ways every engine we have looked at selects a
 * voice, and they are not alternatives to each other so much as different halves of the
 * same question - ElevenLabs has ids and no cloning at this tier, Chatterbox has cloning
 * and no ids worth using, Higgs has both. Carrying both and letting the adapter take
 * what it can use is what keeps `@rv/story-engine` from knowing which engine won.
 */
export const VoiceBinding = z.strictObject({
  /**
   * Provider-native voice identifier, when the engine has a catalogue.
   *
   * Deliberately a bare string: an ElevenLabs voice id, a Higgs preset speaker name and
   * a Chatterbox predefined-voice filename have nothing in common but being opaque.
   */
  presetId: NonEmptyString.max(200).nullable().default(null),
  /** The clip to clone from, for engines that do that. `null` when there is none. */
  exemplar: VoiceExemplar.nullable().default(null),
});
export type VoiceBinding = z.infer<typeof VoiceBinding>;

/**
 * One voice, described in terms no engine owns.
 *
 * The three bias fields are signed and centred on zero so that "no opinion" is
 * expressible and is the default. An adapter maps them onto whatever it has - a pitch
 * tag, a speed multiplier, a stability slider - and an adapter with nothing to map them
 * onto reports them as dropped rather than pretending.
 */
export const VoiceProfile = z.strictObject({
  role: VoiceRole,
  /**
   * Whether a person or an engine performs this voice.
   *
   * Defaulted to `synthetic`, which is the safe default in the direction that matters:
   * a voice that should have been human but was left unmarked shows up as an unexpected
   * provider call in the estimate *before* the run, whereas a voice that should have
   * been synthetic and was left as human shows up as silence in a finished episode.
   */
  performedBy: Performer.default('synthetic'),
  /** The entity this voice belongs to. Present for narrator and character alike. */
  speakerRef: EntityId,
  label: Label.describe('Human-readable name, for the studio and the narrator page.'),
  language: LanguageTag,
  binding: VoiceBinding,
  /** -1 lower than the engine's default, +1 higher. */
  pitchBias: SignedUnit.default(0),
  /** -1 slower than the engine's default, +1 faster. This is the *habitual* rate, not the line's. */
  tempoBias: SignedUnit.default(0),
  /**
   * How much this voice moves at rest, 0 for near-monotone to 1 for theatrical.
   *
   * The baseline a line's `intensity` is applied on top of. Derived from the character
   * sheet - a terse, formal, humourless voice sits low - so that two characters given
   * the same line and the same direction still do not sound the same.
   */
  expressiveness: Unit01.default(0.5),
  /** Why this voice sounds the way it does, in one or two sentences, from the sheet. */
  rationale: Prose.describe(
    'The sentence that connects this voice to the character sheet it came from. Not decoration: it is what a reviewer checks the voice against.',
  ),
});
export type VoiceProfile = z.infer<typeof VoiceProfile>;

// -- the casting --------------------------------------------------------------

/**
 * Every speaker in a series, and how each is voiced.
 *
 * Series-scoped rather than episode-scoped because a voice that changed between
 * episodes would be a continuity break the audience hears before it sees anything, and
 * because the narrator is the same person for the whole run by definition.
 */
export const VoiceCasting = z
  .strictObject({
    /**
     * The entity whose lines the owner reads aloud, or `null` for a series with no
     * narration.
     *
     * One field, and it is the whole of "the narrator is me, the characters are AI".
     */
    narratorRef: EntityId.nullable().default(null),
    language: LanguageTag.describe('The series language. A profile may override it; most do not.'),
    profiles: z.array(VoiceProfile).max(128).default([]),
  })
  .superRefine((casting, ctx) => {
    const seen = new Set<string>();
    casting.profiles.forEach((profile, index) => {
      if (seen.has(profile.speakerRef)) {
        ctx.addIssue({
          code: 'custom',
          path: ['profiles', index, 'speakerRef'],
          message: `${profile.label} is cast twice; one speaker has one voice`,
        });
      }
      seen.add(profile.speakerRef);

      const isNarrator = profile.speakerRef === casting.narratorRef;
      if (isNarrator && profile.role !== 'narrator') {
        ctx.addIssue({
          code: 'custom',
          path: ['profiles', index, 'role'],
          message: 'the narrator entity must be cast in the narrator role',
        });
      }
      if (!isNarrator && profile.role === 'narrator') {
        ctx.addIssue({
          code: 'custom',
          path: ['profiles', index, 'role'],
          message: 'only the entity named by narratorRef may hold the narrator role',
        });
      }

      const bound = profile.binding.presetId !== null || profile.binding.exemplar !== null;
      // A human voice with an engine binding means somebody has quietly arranged for a
      // machine to read a person's lines, and the only place that would surface is the
      // finished episode.
      if (profile.performedBy === 'human' && bound) {
        ctx.addIssue({
          code: 'custom',
          path: ['profiles', index, 'binding'],
          message: 'a human-performed voice must carry no engine binding',
        });
      }
      // The mirror failure, and the quieter one: a synthetic voice with nothing to
      // synthesise from. The adapter would have to invent a voice, and every line this
      // character speaks would arrive in a different one.
      if (profile.performedBy === 'synthetic' && !bound) {
        ctx.addIssue({
          code: 'custom',
          path: ['profiles', index, 'binding'],
          message: 'a synthetic voice needs a preset id or an exemplar clip to be recognisable',
        });
      }
    });

    if (
      casting.narratorRef !== null &&
      !casting.profiles.some((profile) => profile.speakerRef === casting.narratorRef)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['narratorRef'],
        message: 'the narrator is named but not cast',
      });
    }
  });
export type VoiceCasting = z.infer<typeof VoiceCasting>;

/** The profile for one speaker, or `undefined` when they were never cast. */
export function voiceFor(casting: VoiceCasting, speakerRef: EntityId): VoiceProfile | undefined {
  return casting.profiles.find((profile) => profile.speakerRef === speakerRef);
}

/**
 * True when this speaker's lines belong to the owner rather than to a provider.
 *
 * The single predicate the split is made on. Every caller that would otherwise write
 * `speakerRef === casting.narratorRef` calls this instead, so there is one place to
 * change if a series ever has two narrators.
 */
export function isNarrated(casting: VoiceCasting, speakerRef: EntityId): boolean {
  return casting.narratorRef !== null && casting.narratorRef === speakerRef;
}
