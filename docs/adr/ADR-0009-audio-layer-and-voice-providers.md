# ADR-0009 — The audio layer: two outputs, one vocabulary, and where the timeline lives

**Status:** accepted
**Date:** 2026-08-24
**Context docs:** [docs/universal_ai_animation_system.md §27](../universal_ai_animation_system.md),
[docs/00-research.md §9](../00-research.md), [ADR-0008](./ADR-0008-motion-providers-and-representations.md)

## Context

The owner's brief for audio is one sentence: **"the narrator is me, the characters are
AI."** Everything below is an attempt to take that literally rather than as an
implementation detail, because it is a product decision with unusually long reach: it
means one script produces two artefacts with almost nothing in common — a page a person
performs from, and a stream of metered provider calls.

The design document (§27) names five tracks — narration, dialogue, music, SFX, ambience —
and stops there. It does not say where audio lives relative to the animation document,
what an emotion is, or which engine speaks. The owner named three engines: **Higgs v3**,
**Chatterbox** and **ElevenLabs**, and observed correctly that they are not
interchangeable.

Research §9 records what they actually are. The short version is that they differ on the
axis that matters most: one takes named emotion tokens inside the text, one takes a
settings object beside it, and one **has no way to name an emotion at all** — it has a
single scalar. And the finding that reorganised this whole layer: **Chatterbox's stock
multilingual weights do not speak Persian**, which is the series language.

## Decision

### 1. The emotion vocabulary is declared once, with two numbers per member

`SpeechEmotion` lives in `@rv/contracts/audio`, and each of its twenty-six members
carries a **valence** and an **arousal** (`SPEECH_EMOTION_AXES`).

The enum alone would not have been enough. Chatterbox cannot be told "bitterness"; it can
only be told 0.62. An adapter facing that gap would have to invent a mapping, and an
invented mapping inside an adapter is a judgement nobody can find, compare or argue with.
Putting the two axes in the shared vocabulary makes the judgement one artefact, in the
open, that all three adapters read.

The list is deliberately **not** Higgs's 21 tags copied across. Adopting one vendor's list
would quietly make that vendor's dialect the interlingua, which is precisely the coupling
the port exists to prevent. Ours is a superset; each adapter states its own mapping and
reports where it is lossy.

`DeliveryNote.emotion` in `story/story-bible.ts` stays free text. A writer forced to pick
from a list writes worse lines, and the field's own docstring offers "bitter", "pleading",
"flat" as examples. `toSpeechDirection` is the single crossing between the writer's word
and the closed vocabulary, and it **returns the word it could not resolve** rather than
silently flattening the line.

### 2. Audio gets its own timeline, which _references_ the IR's markers

The question was whether audio should hang off `AnimationIR.markers` — which already has
the kinds `dialogue`, `sfx`, `music` and `beat` — rather than introduce a second concept.
It should not, and the reason is not that markers are the wrong shape.

A `Marker` is `{ id, timeMs, kind, label }`: a **point** with no payload, inside a
document that is content-hashed and _is_ the render cache key. Audio is a **span**
carrying bytes, a voice, a cost and a provenance, produced after choreography and
regenerated independently of it. Widening `Marker` to hold that payload would mean **every
retake of a single line changes the animation document's hash and invalidates a render in
which not one pixel moved.** That is the decisive argument. Two supporting ones:

- `evaluate(ir, t)` never reads markers, and ADR-0008 §1 makes the purity of the evaluator
  the determinism boundary. Audio is authored by providers and replayed from artefacts —
  the same status as a baked sprite sheet, which is also not in the IR.
- `Shot.audio` and `Shot.dialogue` already hold authoring _intent_ in shot-relative time
  and had no consumer. `AudioTimeline` is the **compiled** result in episode-absolute
  time, which is exactly the relationship `AnimationIR` has to `Shot[]`. This is the
  second half of a pipeline that already had a first half.

The two are kept in agreement by reference, not duplication: `AudioCue.markerRef` names
the marker a cue is synchronised to, and `checkAgainstMarkers` returns an empty list only
when every referenced marker exists and the times match. The cue-_point_ concept is not
re-invented; only the sound is new.

**What the animation owners need from this:** marker ids that are stable across a
recompile of the same shot list. The audio compiler pins a cue to a marker by exact time
match, and a marker that is re-minted on every choreograph will unpin every cue in the
episode.

### 3. Narrator and character are the same shape, split by one field

Narration is modelled as **an entity that speaks**, not as a new field on `Shot`.
`Shot.dialogue` already carries a `speakerRef`, a `subtext` and a `DeliveryNote`, and
narration needs all three and nothing more. A parallel `Shot.narration` array would
duplicate the shape, and the first time someone wanted the narrator to be sardonic about a
character they would find the field they needed on the other type.

Two orthogonal fields do the work, and keeping them apart was a correction made during the
build rather than a first instinct:

- `VoiceProfile.role` (`narrator` | `character`) is the **narrative function**, and it
  decides which of §27's tracks a line lands on.
- `VoiceProfile.performedBy` (`human` | `synthetic`) is **who makes the sound**, and it
  decides whether a line is typeset or billed.

Conflating them reads fine for the series the owner is making now — where narrator means
"the owner" — and breaks the first time a series has a synthetic voice-over, or a guest
reads a part. `VoiceCasting` refuses a human voice that carries an engine binding, so
nobody can quietly arrange for a machine to read the owner's lines.

### 4. A character's voice is derived from their sheet, never dialled

`CharacterVoice` exists because "the most reliable tell of LLM-written serial fiction is
that every character speaks in the same competent middle register". A separate set of TTS
knobs in a settings panel would reintroduce that failure one layer down and drift from the
sheet the moment either was edited. So `deriveVoiceProfile` computes expressiveness from
verbosity, register, rhythm and humour, and tempo from `sentenceRhythm`.

**`pitchBias` is always zero, and that is a decision.** Nothing in the sheet is about
pitch. Deriving one from register — formal reads low, colloquial reads high — would be
inventing a stereotype and presenting it as a derivation. Pitch belongs to the exemplar
clip or the preset voice, which is a casting decision a person makes.

### 5. The epistemic layer reaches the voice, and `mistaken` changes nothing

`SpeechStance` is the one thing in this layer that a system without a belief graph could
not have. From an `EpistemicView` plus what the audience has been shown we can ask whether
a speaker is wrong and whether the viewer already knows it.

The load-bearing rule is counter-intuitive: **a sincerely mistaken line must be delivered
more sincerely, not knowingly.** The irony belongs to the audience; a voice that winks at
it destroys the effect the scene was built for. Every adapter is required to add nothing
for `mistaken`, and there is a test per engine asserting that a `mistaken` line and a
`plain` line produce byte-identical requests.

`ironic` is never inferred. Irony is a line meaning its opposite, and no edge in the graph
says that — it is an authorial decision living in prose. A heuristic over `subtext` would
make a character sarcastic in a scene where they were sincere, which is worse than
flatness.

### 6. Language is a declared capability per **checkpoint**, not per engine

This is the change research §9 forced. `SpeechCapabilities.languages` is declared by the
loaded weights, not by the vendor name, because Chatterbox's stock multilingual model has
no Persian while community Persian fine-tunes of the same architecture exist. An adapter
constructed with different weights declares different languages, and `speechRefusal`
returns `UnsupportedCapabilityError` **before the socket opens**.

An empty list means "unverified", which is read as _do not refuse_ rather than _refuse_.
Refusing on ignorance would make every model whose documentation we have not read
unroutable.

### 7. An adapter emits only tags it has verified

Higgs's model card says it outright: _"Only the tags below are recognized — anything else
degrades output or gets read literally."_ So `HIGGS_EMOTIONS`, `HIGGS_STYLES` and
`HIGGS_PROSODY` are a closed table copied from the card, and a test asserts that no token
the renderer can produce falls outside them.

ElevenLabs is the harder case, because its published tag list is **examples rather than a
closed vocabulary**. The conservative side is taken: only tags appearing verbatim in the
documentation are emitted, and every other emotion is reported as **dropped** and
expressed through `voice_settings` alone. Inventing `[bitter]` because it looks like
`[curious]` would probably work, would occasionally be read aloud as the word, and would
be indistinguishable in this repository from a verified mapping.

`RenderedDirection` carries that honesty per call: `applied`, `approximated` and `dropped`.
An adapter that silently swallowed `volume: 'raised'` and one that expressed it are
indistinguishable in the audio to anyone who was not there; they are not indistinguishable
in the provenance record.

### 8. Speech is priced in its own table, per character

`SpeechPricing` and `KNOWN_SPEECH_MODELS` sit beside `Pricing` and `KNOWN_MODELS` rather
than inside them. Speech bills in a unit nothing else uses, and the refinements that make
`Pricing` trustworthy have no speech analogue. Folding a character rate in would have put
a null in every existing entry to mean "not a voice model".

`quoteSpeech` is a **required** member of the port for the same reason `quoteImage` is
required on `ImageGenerationPort`, and the argument lands harder here: the _adapter_
composes the billed string. An adapter that adds `[whispers]` has added eleven billable
characters, so a quote computed by the caller from the raw line would be low on exactly
the expressive lines a series has most of.

## What we are not doing, and why

**A music or SFX generation port.** The timeline carries `bed` and `effect` cues addressed
by `SemanticKey`, which is enough to compile, mix and cost a run against a library. A
generative music provider is a registration under the same pattern when there is one to
register; declaring the port now would be declaring a shape with no implementation to
check it against.

**Forced alignment for lip-sync.** `DialogueLine.phonemes` still says "empty until the
audio exists; never authored by hand", and it still is. ElevenLabs returns character-level
timing and that is carried through as `SpeechResult.alignment`; the other two return
nothing and the field is `null` rather than a fabrication. Turning characters into visemes
is a separate piece of work with its own correctness question, and a guessed alignment
would be trusted by the rig.

**MP3 duration measurement.** WAV states its length in its header and is read; MP3 needs a
frame scan and returns `null`. A cue with a guessed length mistimes every cue after it, so
the type refuses to supply a plausible number and the compiler refuses to lay out an
unmeasured cue.

**A verified Persian speaking rate.** The narrator's page warns when a passage will not fit
its window, using `ASSUMED_PERSIAN_CHARS_PER_SECOND`. Nothing in research covers this, so
the constant is generous, named as a working figure in its own docstring, and injectable.
The real number comes from the owner's first recorded read.

## Consequences

- A second take of a line is a new artefact and a new content hash; the animation document
  and its render are untouched. That is the point of §2 and it only holds while nothing
  writes audio into the IR.
- The router can refuse a Persian line to Chatterbox before spending anything, and will
  keep doing so until someone declares different weights. A `speech.languages` override
  changed without changing the weights ships an episode in the wrong language.
- Every provider call now reports what it could not express. Consumers should treat a
  non-empty `dropped` list as a review item rather than a log line.
- `Capability` gained `speech-synthesis` and `ProviderKind` gained three members, so the
  capability matrix, the task map and their pinning tests all move together — which is the
  mechanism working, not friction.
- ElevenLabs is **unverified against the live API**. The fixtures encode the documented
  shapes; the first real call is a test in itself.
