# Screen briefs

One brief per unbuilt studio screen. Each names the job, the primary path, and the trap
specific to that screen — the thing that will be got wrong if nobody writes it down.

Written before implementation on purpose. A screen whose job cannot be stated in one
sentence is being decorated rather than designed, and every later judgement about it is
arbitrary.

---

## Rules that apply to all six

**Direction is a constraint, not a retrofit.** Logical properties only —
`margin-inline-start`, `inset-inline-end`, `padding-block`. Never `left`/`right`. A
layout built on physical properties has to be rewritten to mirror; one built on logical
properties mirrors for free. Icons that encode direction mirror; icons that encode a
real-world object do not.

**Five states, not one.** Empty, loading, partial, error, full. An empty state is an
invitation — say what the screen is for and give the one action that fills it. A loading
state preserves layout: skeletons shaped like the real content, never a centred spinner
that makes the page jump. An error names what failed and what to do about it.

**Cost before commitment.** Every action that spends money or takes minutes shows the
estimate first. An estimate someone approved is a different experience from a bill they
discovered. This is not a nicety here — it is the third non-negotiable.

**Latency.** Under 100 ms, do nothing. Up to 1 s, an inline indicator. 1–10 s, determinate
progress and a responsive interface. Over 10 s, the operation must be survivable: a
resumable job and a URL to come back to.

**No user-visible string outside the message catalogues.** RV-216 tests this. Persian and
English both, and Persian runs longer than English — a control sized to its English label
will break.

**Numerals** display in the user's locale; the underlying value stays canonical. Never
parse a localised string back into a number.

---

## Style Lab — RV-204

**Job.** Someone starting a series has an idea and no visual language. They leave
satisfied when they have _seen_ a style rendered rather than described, including how it
moves, and locked it with a checksum nothing downstream can drift from.

**Path.** Choose a preset (or derive one from reference images) → probe → lock. Three
decisions. Do not make it four.

**The trap: the motion half is invisible in a still.** Eleven presets are authored with
motion profiles as distinct as their palettes — a paper-cutout world hinges and holds on
2s, a watercolour one arcs and boils. A gallery of static cards throws away half of what
distinguishes them, and the user picks on colour alone and is surprised later. **Every
preset card moves.** Under `prefers-reduced-motion`, replace the loop with a
representative frame sequence the user can step through — remove the travel, not the
information.

Second trap: probing costs a model call. Show the estimate and the lane before the button
does anything, and make the free lane the obvious default.

Locking is irreversible in the sense that matters — everything generated afterwards
depends on the checksum. Confirm that one. Do not confirm anything else on this screen.

---

## Story — RV-205

**Job.** Someone with a locked style and an idea in Persian leaves satisfied when a story
tree exists at every level, they have edited at least one beat and it stuck, and they can
see which model wrote which part.

**Path.** Type the idea → watch the outline build level by level → open any node and edit.

**The trap: a generated tree invites "regenerate everything".** The outliner is DOC-shaped
and structurally cannot skip a level; that discipline is the reason the story holds
together, and a prominent regenerate button quietly discards it. Editing a beat must not
silently invalidate its children — say what an edit affects _before_ it happens, and let
the user keep the children if they want them.

The per-stage model picker belongs here and not only in settings: choosing a different
brain for the outline than for dialogue is a normal thing to want mid-draft. Show what
each stage costs at its current binding.

Generation takes tens of seconds. That is the 1–10 s band at best and usually past it —
stream it, level by level, and keep the tree readable while it grows.

---

## Characters — RV-206, RV-207

**Job.** Someone who needs strong, distinct characters leaves satisfied when every
character carries want / need / wound / lie / ghost, a distinct voice and a motion
signature, when the multi-state prompt set is complete and editable, and when they can ask
_what did this character know at E05_ and get an answer.

**Path.** Cast list → one character → their sheet, their state grid, their knowledge.

**The trap: the graph is the hard part and a force-directed hairball is useless.** The
relations that matter are few and typed. Show those. The bi-temporal standpoint — "as of
E05" — is not a hidden filter, it is the feature: make it a first-class control on the
screen, and make the difference between _knows_, _believes falsely_ and _does not know_
visible at a glance. Dramatic irony is representable in this model; a UI that flattens it
to a single edge colour throws away the reason the model exists.

Second trap: sixteen-odd state cells per character, each with a prompt behind it, becomes
a wall of text. The grid shows the _image_ — the prompt is one click away and edits in
place. Colour may never be the only signal distinguishing cell states.

---

## Assets — RV-208, RV-209, RV-210

**Job.** Someone who wants to know what exists, what it cost, and how to change one thing
without regenerating everything. They leave satisfied when they can find an asset, see its
parts, clips and version history, and produce a variant with the original intact.

**Path.** Library → asset → version → edit by instruction → new variant.

**The trap: this screen is where the second non-negotiable is either upheld or quietly
broken.** No asset is generated twice. Regeneration must _feel_ deliberate: an explicit
intent, the cost shown first, and unmistakable evidence that a new version was appended
rather than the original overwritten. If a user can regenerate by accident, the invariant
is decoration.

Plan before produce is the same rule in the other direction — show hits, misses and the
exact estimate before anything is spent. A run that resolves to 100 % hits should say
`$0.00` and mean it.

An asset that failed at a step is not a missing asset; it is an asset that reached step
four of eight. Show where it stopped and why, because "matte removed nothing, coverage
0.99" is a _diagnosis_ and the user can act on it.

---

## Timeline — RV-211, RV-212

**Job.** Someone adjusting how things move leaves satisfied when the preview matches what
will render and an edit shows up immediately.

**Path.** Load a scene → scrub → drag a keyframe → see it.

**The trap: the preview must agree with `evaluate(ir, t)` exactly.** One bezier solver is
shared by the renderer, the sheet baker and the Lottie exporter for precisely this reason
— three implementations of the same curve is three answers. The player must use that one
too. A preview that lies makes every downstream decision guesswork, and it lies most where
it matters least visibly: eased interpolation between distant keyframes.

Scrubbing is a 60 fps interaction. It cannot round-trip to the server, which means the IR
evaluator runs in the browser. Budget for that.

Keyframe drag needs undo, not confirmation. Anything reversible gets undo; save
confirmation dialogs for the irreversible.

---

## Render and delivery — RV-213, RV-214, RV-215

**Job.** Someone ready to publish leaves satisfied when seven files exist and each one
passes its platform's spec.

**Path.** Pick formats → see each previewed with its safe zone → estimate → deliver.

**The trap: the safe zone is the entire reason to preview.** TikTok's own interface covers
a substantial part of the frame; a preview that shows the raw crop is showing something
the audience will never see. Overlay the real zones from the format profiles, and make the
reframer's decision visible — this crop keeps the focus inside the safe area, or this one
honestly letterboxes because no crop could.

A render takes minutes. That is well past the ten-second threshold, so it must be
survivable: leave the page and come back, resume a killed render, and get told when it is
done. The run is already checkpointed and resumable — surface that rather than hiding it
behind a modal the user must not close.

Show cost per delivered minute, not just cost per run. That is the number that tells
someone whether this is affordable at series length.
