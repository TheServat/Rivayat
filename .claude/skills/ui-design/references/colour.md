# Colour

Most interface palettes fail for one of two reasons: they were picked as swatches instead of as a system, or they were picked in sRGB hex, where equal numeric steps are not equal perceptual steps.

## Work in OKLCH, ship whatever you like

`oklch(L C H)` — lightness 0–1, chroma 0–0.4ish, hue 0–360 — is perceptually uniform. That means:

- Changing **L** alone changes only how light a colour looks, not its hue or saturation. In HSL it does neither reliably: `hsl(60 100% 50%)` (yellow) and `hsl(240 100% 50%)` (blue) have the same declared lightness and differ by a factor of about five in perceived brightness.
- A ramp built by stepping **L** produces evenly-spaced steps. A ramp built by stepping HSL lightness produces a muddy middle and a washed-out top.
- Two colours at the same **L** will have similar contrast against the same background, which makes an accessible system predictable instead of trial-and-error.

Browsers support `oklch()` natively. Author in it; there is no conversion step.

## Building the ramp

For each hue in the palette, generate a ramp by fixing H, varying L on a deliberate curve, and letting C peak in the middle:

```
step   L      C        role
 50   0.98   0.01     page tint, barely there
100   0.95   0.03     subtle fill
200   0.90   0.06     hover fill, dividers
300   0.82   0.10     borders
400   0.70   0.15     disabled text, icons
500   0.58   0.19     the colour — badges, accents
600   0.50   0.19     primary action
700   0.42   0.16     hover on primary
800   0.32   0.11     pressed, strong text
900   0.22   0.07     headings on light
950   0.15   0.04     deepest
```

Chroma must fall at both ends. Near-white and near-black cannot hold saturation — pushing C at L=0.95 produces a colour outside the display gamut that the browser silently clips, and your careful ramp gets a flat spot.

## How many hues

Fewer than you think. A complete interface needs:

- **One neutral ramp.** Not pure grey — give it a slight chroma (0.005–0.02) at the hue of your primary. Warm greys under a warm accent, cool under a cool one. Pure `#808080` next to a coloured accent looks dead.
- **One primary.** The brand, the primary action, the focus ring.
- **One or two accents,** used sparingly, for the thing that must be noticed.
- **Semantic:** success, warning, danger, info. These are constrained by convention — red for danger is not a choice you get to make — but their *lightness and chroma* should match your ramps so they look like they belong.

That is four to six hues. A palette with eleven is not richer, it is undecided.

## Contrast

Verify, do not eyeball. WCAG 2.2 AA: **4.5:1** for body text, **3:1** for large text (≥24 px, or ≥19 px bold) and for the visual boundary of controls and focus indicators.

WCAG's ratio is computed in sRGB relative luminance, so an OKLCH L value does not map to it directly — build the ramp in OKLCH for evenness, then **measure** the pairs you actually ship. Useful rules of thumb that hold in practice: L ≥ 0.62 against a white background will usually fail body text; L ≤ 0.45 against white will usually pass.

Contrast is a *pair* property. There is no such thing as an accessible colour, only an accessible combination — so the token that matters is the pair, and the tests you write should assert on pairs.

## Dark mode is not an inversion

Inverting a light palette produces glare and muddy accents. What actually changes:

- **Surfaces get lighter as they come forward,** the opposite of light mode where they get darker. Elevation in dark mode is expressed by lightness, not by shadow — a shadow on a dark background is invisible.
- **Never pure black** for the page. `oklch(0.16 0.01 <hue>)` or so. Pure black maximises the halation around light text on OLED and is physically tiring.
- **Reduce chroma.** A saturated colour that reads as confident on white reads as radioactive on near-black. Drop C by roughly a third.
- **Text is not pure white either.** `oklch(0.95 …)` reads as crisp; `#fff` reads as harsh.
- Contrast requirements are identical. Dark mode is not an excuse for grey-on-grey.

## Tokens, in two layers

Do not let a component name a colour. Two layers:

```css
:root {
  /* 1. Primitive — the ramp. Named by what it IS. */
  --moss-500: oklch(0.58 0.11 145);
  --moss-600: oklch(0.50 0.11 145);

  /* 2. Semantic — named by what it DOES. Components use only these. */
  --color-action:        var(--moss-600);
  --color-action-hover:  var(--moss-700);
  --color-text:          var(--sand-900);
  --color-text-muted:    var(--sand-600);
  --color-surface:       var(--sand-50);
  --color-surface-raised:var(--sand-100);
  --color-border:        var(--sand-300);
  --color-focus:         var(--moss-500);
}
```

Dark mode redefines **only the semantic layer**. The primitives stay. That is the whole reason for the split, and it is what makes a theme a twenty-line block instead of a rewrite.

A component that writes `var(--moss-600)` has hard-coded a decision it does not own. A component that writes `var(--color-action)` will theme correctly forever.

## Colour must never be the only signal

Roughly one in twelve men has a colour vision deficiency. Every state distinguished by colour needs a second channel: an icon, a label, a shape, a weight, a position. A red border and a green border are the same border to a significant fraction of your users — pair them with an icon and text.

## Self-check

Render the interface in greyscale. If you can still tell what is primary, what is an error, and what is disabled, the hierarchy is carried by structure and lightness rather than by hue alone — which is what you want. Then check the two or three lowest-contrast pairs with a real contrast tool, not by looking.
