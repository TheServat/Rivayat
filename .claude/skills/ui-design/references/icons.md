# Icons

An icon is a word compressed into a shape. It only works when the reader already knows the word — so an icon's job is *recognition speed*, never *explanation*.

## The rule almost everyone breaks

**An icon alone communicates reliably for perhaps a dozen symbols.** Home, search, close, back, play, pause, settings, trash, plus, download, share, menu. Everything else — history, filter, layers, export, archive, sync — is guessed at, and different people guess differently.

So: **icon plus label by default.** Icon-only is for controls that are either in the recognised set, or repeated so often in a dense surface (a toolbar, a table row) that the user learns them in a session. Every icon-only control needs an accessible name and, in most cases, a tooltip on hover *and* focus.

## Picking one set and staying in it

Mixing icon sets is the single most common way an interface looks unfinished. Sets differ in stroke width, corner radius, optical size, grid, and how much detail they carry — and the eye reads the inconsistency instantly even when it cannot name it.

Choose one, and choose on these axes:

- **Stroke vs. filled.** Stroke sets read lighter and pair with lighter typography; filled sets read heavier and hold up better at small sizes. A set that offers both, with the filled variant reserved for the *selected* state, gives you a free state signal.
- **Stroke width relative to your type.** A 1 px icon next to a 600-weight label looks anaemic; a 2 px icon next to a 300-weight label shouts. Match the icon's optical weight to the text it sits with.
- **Grid and optical size.** Icons drawn on a 24 px grid and displayed at 16 px lose their crispness because strokes land off-pixel. Prefer a set with multiple optical sizes, or display at the size it was drawn for.
- **Coverage.** Check the set has the awkward ones your domain needs *before* adopting it. Running out and borrowing one icon from elsewhere is how sets get mixed.

Good open sets, all MIT or similar: **Lucide** (stroke, huge coverage, the de-facto default), **Phosphor** (six weights including a duotone), **Radix Icons** (15 px, unusually crisp at small sizes), **Tabler** (very large, consistent 2 px stroke), **Material Symbols** (variable font — weight, fill and optical size are axes you can animate).

## Sizing and alignment

- Size icons to the **cap height** of adjacent text, not to its font-size. An icon set to `1em` next to 16 px text looks oversized because the text only occupies ~11 px of that. `0.875em`–`1em` with optical adjustment usually lands right.
- Align to the text baseline optically, not mathematically. Circular and triangular glyphs need to sit a fraction lower than square ones to look level — this is why a play triangle looks off-centre when perfectly centred.
- Give icon-only buttons a hit target of **at least 24×24 CSS px** (WCAG 2.2 SC 2.5.8), and 44×44 on touch. The icon can be 16 px inside a 40 px button; the padding is the target, not the glyph.

## Colour and state

Icons inherit `currentColor`. Let them — an icon with a hard-coded fill will not follow your theme, will not dim when disabled, and will not invert in dark mode.

```css
.icon { width: 1em; height: 1em; fill: none; stroke: currentColor; }
```

Decorative icons that sit next to a text label are redundant to a screen reader and must be hidden: `aria-hidden="true"`. Icons that *are* the control need the name on the control, not on the icon.

## Motion

Icons are the cheapest place in an interface to add life, and the easiest place to overdo it.

- **State transitions earn animation.** Menu → close, play → pause, unchecked → checked, collapsed → expanded. Morph between them rather than swapping; the morph tells the user the two states are the same control. 120–180 ms.
- **A single animated icon can carry a whole loading state** — a spinner, a pulsing dot, a progress ring — and costs far less attention than a full-screen overlay.
- **Hover micro-motion** (a 2° rotate, a 4 % scale) is effective on one or two controls and exhausting on twenty. Reserve it for the primary action.
- Everything here goes off under `prefers-reduced-motion`. A morph becomes an instant swap.

Variable-font icon sets make some of this trivial: animating the `FILL` axis from 0 to 1 is a genuine morph with no path interpolation.

## Illustration is a different tool

An icon is functional; an illustration is atmospheric. Use illustration where there is nothing to do — an empty state, an onboarding step, a success screen — and it should carry the product's own visual world, not a generic set of purple blobs with floating rectangles. A stock illustration style that appears in a hundred other products actively removes personality.

If the product already generates its own imagery, use *that*. An empty asset library that shows a real asset from the project's own style is worth more than any purchased illustration.

## Delivery

- **Inline SVG** for anything that needs to change colour, animate, or respond to state. It costs a little markup and buys everything.
- **Sprite sheet** (`<use href="#id">`) when the same icons repeat many times per page and the markup weight is measurable.
- Never an icon **font** for new work. Icon fonts break when the font fails to load, land on unpredictable baselines, and are read aloud as garbage by some screen readers.
- Do not ship the whole set. Tree-shake to the icons actually used; a component-per-icon library plus a bundler does this by default, and a 300 KB icon bundle for eleven icons is pure waste.

## Self-check

Cover every label and look at the toolbar. The controls you cannot name are the ones that need labels — not better icons.
