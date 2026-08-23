---
name: ux-review
description: Interaction and usability work — designing a flow, reviewing a screen, or auditing an interface for accessibility and state coverage. Use when asked to review UX, check accessibility, design a user flow, handle empty/loading/error states, or judge whether an interface is actually usable rather than merely pretty.
---

# UX Review

Visual design decides whether an interface is admired. Interaction design decides whether it is *used*. This skill is about the second thing: the states, the affordances, the failures, and the parts nobody screenshots.

Its companion is `ui-design`, which owns aesthetic direction. Load that one when the question is "what should this look like"; load this one when the question is "does this work".

## Start by naming the job

Before reviewing or designing anything, write down in one sentence: **who is here, what they came to do, and what has to be true for them to leave satisfied.** If you cannot, you are decorating rather than designing, and every later judgement will be arbitrary.

Then name the *interaction cost* of the primary path — how many decisions, inputs and page changes stand between arriving and being done. That number is the thing to reduce. Everything else is secondary.

## The five states every screen has

Most interfaces are designed for one state and shipped with five. Walk them explicitly, every time:

| State | The question it answers | Common failure |
|---|---|---|
| **Empty** | What is this and how do I start? | A blank panel, or a spinner that never resolves because there is nothing to load |
| **Loading** | Is it working, and roughly how long? | A full-page spinner that discards the layout the user was reading |
| **Partial** | Some of it arrived. Can I act on that? | All-or-nothing rendering that hides usable data behind one slow call |
| **Error** | What broke, and what do I do now? | "Something went wrong" — which says nothing and offers nothing |
| **Full** | The state everyone designs | — |

An empty state is an invitation, not an apology: say what the screen is for and give the one action that fills it. A loading state should preserve layout — skeletons that match the real content's shape, not a centred spinner that makes the page jump when data lands. An error must name what failed and what the person can do; if a retry might work, offer the button.

## Feedback and latency

People forgive slowness. They do not forgive silence.

- **Under ~100 ms** feels instant. Do nothing.
- **100 ms – 1 s** — the user notices but stays oriented. A subtle inline indicator is enough.
- **1 – 10 s** — show progress and keep the interface responsive. Determinate progress if you know the total; indeterminate only if you genuinely don't.
- **Over 10 s** — the user will leave and come back. Make the operation survivable: a resumable job, a notification, a URL they can return to.

Every action gets acknowledgement within one frame, even if the result takes longer. A button that does nothing visible for 400 ms gets clicked twice.

**Optimistic updates** are right when the operation almost always succeeds and is cheap to reverse. They are wrong when failure is plausible or the rollback would confuse — showing a thing as saved and silently un-saving it is worse than a half-second wait.

## Destructive and expensive actions

Confirm what cannot be undone; make everything else undoable instead of confirmed. A confirmation dialog on a reversible action trains people to click through dialogs, which is exactly what you don't want when a real one appears.

For anything that **spends money or takes minutes**, show the cost or duration *before* committing, not after. An estimate the user approved is a different experience from a bill they discovered.

## Forms

- One idea per field; label every one, visibly, and keep the label visible while typing.
- Validate on blur, not on every keystroke; show the error next to the field that caused it.
- Never block paste. Never silently trim or reformat what someone typed without showing it.
- Preserve input across failure. Losing a filled form to a server error is the single most enraging thing an interface can do.
- The submit button says what happens (`Save changes`, `Publish`), and the confirmation uses the same word.

## Accessibility is a floor, not a feature

Target **WCAG 2.2 AA**. The criteria that catch the most real problems:

- **Contrast** — 4.5:1 for body text, 3:1 for large text and for the visual boundary of controls and focus indicators.
- **Keyboard** — every interactive element reachable and operable by keyboard, in a logical order, with a *visible* focus indicator. Never remove an outline without replacing it.
- **Target size** — 24×24 CSS px minimum for pointer targets (2.5.8), and larger on touch.
- **Motion** — honour `prefers-reduced-motion`. Anything that flashes more than three times a second is a seizure risk, not a style.
- **Names** — an icon-only control needs an accessible name. A decorative icon needs to be hidden from assistive tech.
- **Semantics first** — `<button>` for actions, `<a>` for navigation, real headings in order. Reach for ARIA only when no element expresses the thing.
- **Live regions** — anything that appears without user action (a toast, an async validation message) must be announced.

Check `references/web-interface-guidelines.md` for the tactical line-by-line list. It is Vercel's Web Interface Guidelines, vendored so a review works offline and against a pinned version.

## Internationalisation and direction

If the interface ships in more than one language, direction is a design constraint from the first component, not a retrofit.

- Use **logical CSS properties** — `margin-inline-start`, `inset-inline-end`, `padding-block` — never `left`/`right`. A layout built on physical properties has to be rewritten to mirror; one built on logical properties mirrors for free.
- Icons that encode direction (back, next, send) mirror. Icons that encode a real-world object (a clock, a play button) do not.
- Text expands. German and Persian both run longer than English; a button sized to its English label will break.
- Numerals: display in the user's locale, but never parse a localised string back into a number. Keep the underlying value canonical.

## Reviewing an existing screen

Work in this order, because each step invalidates the next if it fails:

1. **Job** — can you state what this screen is for in one sentence? If not, that is the finding.
2. **Path** — walk the primary task end to end. Count decisions and inputs.
3. **States** — force all five. Disconnect the network. Empty the data. Make the request fail.
4. **Keyboard** — do the whole task without touching the mouse.
5. **Contrast and target size** — measure, do not eyeball.
6. **Copy** — read every string aloud. Anything that names a system concept instead of a user concept is a defect.
7. **Motion** — turn on reduced motion and confirm the interface still communicates state changes.

Report findings as `file:line — what is wrong — what it costs the user`. A finding without the third part is an opinion.

## Heuristics worth keeping in mind

Nielsen's ten still earn their keep; these four catch the most:

- **Visibility of system status** — the interface always says what it is doing.
- **Match to the real world** — speak the user's vocabulary, not the schema's.
- **User control and freedom** — a clearly marked exit from any state, and undo over confirm.
- **Error prevention over error messages** — a constraint that makes the mistake impossible beats a message explaining it.

And two that predict measurable behaviour: **Fitts** (time to hit a target grows with distance and shrinks with size — put the common action large and near), and **Hick** (decision time grows with the number of choices — a menu of twenty needs structure, not scrolling).

## What not to do

Do not report accessibility findings you have not verified. Do not describe a screen as "clean" or "modern" — those words carry no information and cannot be acted on. Do not propose a redesign when the finding is a missing empty state. And do not confuse *fewer clicks* with *less effort*: one screen with thirty fields is worse than three screens with ten.
