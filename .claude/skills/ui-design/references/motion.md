# Motion

Motion in an interface has one job: to make a change **legible**. Something appeared, something moved, something is loading, something failed. If an animation is not answering one of those, it is decoration and it is costing the user time.

## Durations that read as intentional

| Range | Use |
|---|---|
| **80–120 ms** | State flips on a control — hover, press, checkbox, toggle |
| **150–250 ms** | Element enters or leaves; a panel opens; a tooltip appears |
| **250–400 ms** | A layout rearranges, a route transitions, a drawer slides |
| **400–700 ms** | A deliberate, once-per-session moment: a first-load reveal, a success celebration |
| **Over 700 ms** | Almost always wrong for UI. If it is genuinely needed, it must be interruptible |

Bigger objects travel further and should take longer. A full-screen sheet at 120 ms looks broken; a checkbox at 400 ms looks sluggish. Scale duration with distance, not with importance.

**Exits are faster than entrances.** Roughly 70 % of the entry duration. The user has already decided; do not make them wait to be rid of something.

## Easing

Never `linear` for anything a user perceives as a physical object — it reads as mechanical because nothing in the physical world moves that way. Reserve it for continuous ambient motion (a spinner, a marquee) where there is no start or stop.

| Curve | `cubic-bezier` | When |
|---|---|---|
| **Standard** | `0.2, 0, 0, 1` | The default for most UI movement. Fast out, gentle settle |
| **Decelerate** | `0, 0, 0.2, 1` | Something entering from off-screen |
| **Accelerate** | `0.4, 0, 1, 1` | Something leaving the screen entirely |
| **Emphasised** | `0.2, 0, 0, 1` over a longer duration | The one moment on the page you want noticed |
| **Spring / overshoot** | `0.34, 1.56, 0.64, 1` | A control that should feel physical — a toggle, a drag release. Use sparingly |

Anticipation (dipping *away* before moving toward) and overshoot (passing the target and settling back) are what make motion feel authored rather than interpolated. One or the other, on one element, is usually the right amount for a whole screen.

## Choreograph, don't scatter

Several elements animating independently reads as noise. Several animating in a **deliberate sequence** reads as design.

- **Stagger** a list by 20–40 ms per item, and cap the total: after about six items, stop increasing the delay or the last row arrives after the user has already started reading.
- **Anchor the transition to the thing that caused it.** A panel opened by a button should feel like it came from that button, not from the edge of the screen.
- **Move one property well** rather than four at once. Opacity plus a small transform is almost always enough; add a third only if it carries meaning.
- **Never animate `width`, `height`, `top` or `left`.** They force layout on every frame. Use `transform` and `opacity`, which the compositor can handle without touching layout or paint.

## Shared-element transitions

When the same object appears on both sides of a change, move it rather than cross-fading it. The user tracks the object and never loses their place. In a browser this is `view-transition-name` where supported, or FLIP (measure First, apply Last, Invert the delta, Play it back) where not. This is the single highest-value motion technique in an interface with navigation.

## Loading and progress

- Skeletons should match the **shape** of the content that will replace them, so nothing jumps when data lands. A skeleton that is the wrong size is worse than no skeleton.
- Do not show a loading indicator for something that will resolve in under ~200 ms; the flash is more disruptive than the wait.
- Indeterminate spinners are an admission you don't know the duration. Where you do know, show it.

## Reduced motion is not optional

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

That blanket rule is the floor, not the goal. Better: keep the *state change* visible and remove the *travel*. Something that faded and slid in should still fade — the fade communicates arrival; the slide is what causes discomfort. Cross-fades and opacity changes are generally safe; large-area movement, parallax and looping motion are not.

## Vue specifics

- `<Transition>` and `<TransitionGroup>` handle enter/leave and list reordering. `TransitionGroup` gives you FLIP move animations for free — use it before writing anything by hand.
- Prefer CSS transitions over JS animation for anything a stylesheet can express; the browser can run them off the main thread.
- For JS-driven motion, the Web Animations API (`element.animate()`) is built in and composited. Reach for a library only when you need timeline orchestration a handful of `animate()` calls cannot express.
- Respect reduced motion in code as well as CSS: `useMediaQuery('(prefers-reduced-motion: reduce)')` from VueUse, and skip the animation entirely rather than shortening it.

## Self-check

Turn every animation off and use the interface. If nothing became harder to understand, the motion was decoration — delete it. Then turn them back on and watch a state change five times in a row: anything that irritates on the fifth viewing is too long, too bouncy, or shouldn't be there.
