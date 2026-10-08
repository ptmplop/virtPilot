# VirtPilot frontend — design system ("Instrument")

The interface is built from the **Heading** logo (`public/brand/`, kit in `websites/virtpilot-logo/kit`):
an instrument ring with a 40° gap at 45° and a steel needle. Calm, precise, quietly confident.
Newness comes from structure and type; colour stays quiet.

## The frame

- **Canvas** (`bg-canvas`): the window and the sidebar. The sidebar follows the theme — light in light
  mode, ink in dark — and shows the full-colour logo (`-dark` files in dark mode).
- **Sheet** (`bg-background`): each page is an inset sheet (12px corner, hairline) on the canvas.
  `Layout` owns it; pages never paint their own page background.
- **Panels** (`.panel` / `<Panel>`): instruments on the sheet. White (`bg-card`), 1px `border-border`,
  8px corner (`rounded-lg`; `rounded-xl` is aliased to the same radius), no lift, no glow.

## Primitives — use these, don't restyle per page

| Need | Use |
|---|---|
| A boxed group with a title | `<Panel>` + `<PanelHeader title meta actions />` (title bar = 48px, label left, readouts/actions right) |
| A row of numbers (counts, totals) | `<StatStrip>` + `<Stat label value sub tone />` — ONE ruled strip, never a grid of identical cards |
| A section of the page | `<SectionHeading label="…" />` (label + steel tick + hairline) |
| VM state | `<StatusBadge status />` / `<StatusGlyph status />` — the glyph *shape* encodes state (disc running, ring stopped, bars paused, diamond crashed) |
| A warning that isn't a VM state | `<WarnGlyph />` |
| A proportion of a whole | `<RingGauge value tone>` (the logo ring) — dashboard; or a 5px bar on `bg-gauge-track` |
| Buttons | `<Button variant="primary\|secondary\|ghost\|danger\|dangerOutline" size="sm\|md">` — primary is **ink** (`bg-action`), not steel, and marks the one main action of a view; actions repeated down a table are `secondary` |
| Tabs/filters with 2–6 options | `.segmented` container, `aria-pressed` on the chosen `<button>` |
| Table | panel → `.table-head` row (12px medium muted on `bg-surface`) → rows with `divide-y divide-border`, `.table-row` hover |
| Fields | `<Input>` / `<Select>`, or `h-9 rounded-md border border-input bg-field px-3 text-[13.5px]` + `focus:border-ring focus:ring-[3px] focus:ring-ring/20` |

## Recurring patterns

- **Selectable option cards** (size presets, CPU mode, firmware…): resting `border-border bg-card
  hover:border-muted-foreground/40`; chosen `border-primary bg-accent ring-1 ring-primary/30`.
  A "default" marker is quiet text (`text-[11.5px] text-muted-foreground`), never a pill.
- **Callouts**: attention = `rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-2.5
  text-[12.5px] text-amber-800 dark:text-amber-200` with a `<WarnGlyph />`; info = same shape on
  `bg-surface border-border text-muted-foreground`; error = the destructive equivalent.
- **Empty states**: centred text in the panel body (`py-12`), one line of muted copy and, if there is
  one, a single action. No icon tile above it — a plain 20px muted icon at most.
- **Tabs** (VM detail): underline tabs — 13.5px medium, muted at rest, ink when active with a 2px
  steel underline (`border-primary`); the bar sits on a full-width hairline.
- **Row actions**: ghost icon buttons (`h-8 w-8 rounded-md text-muted-foreground hover:bg-muted
  hover:text-foreground`), destructive ones `hover:text-destructive hover:bg-destructive/10`;
  every icon-only button has `aria-label` and a `<Tooltip>`.
- **Keys and values**: label column `text-[12.5px] text-muted-foreground`, value `font-mono text-[12px]
  text-foreground`, rows ruled with `divide-y divide-border`.

## Colour

- Text: `text-foreground` (ink/frost), `text-muted-foreground` for secondary. No faded text below
  `/80`; it fails contrast. Light-theme coloured text uses 700 shades with a `dark:` 300 pair
  (`text-emerald-700 dark:text-emerald-300`).
- Steel (`text-primary`, `border-primary`, `bg-accent`, `ring`) marks what the eye should follow:
  focus, selection, links, the active nav item's icon, data series. It is NOT the primary button.
- Status: green = running/healthy, amber = attention, red = failed/destructive. Solid red only on the
  button that confirms a destructive act.
- Charts: `lib/chartColors.ts` (CPU steel, memory heather, inbound steel / outbound ochre dashed).

## Type

Inter (opsz build: headline sizes switch to Inter Display, the wordmark's face) + JetBrains Mono for
identifiers (IDs, paths, MACs, IPs, versions). Page title 26px/600; panel title 13.5px/600; body 13.5px;
labels 12–12.5px/500 muted; readouts 26px/600 tabular. Nothing below 11px (mono identifiers and axis ticks); labels 12px+. Sentence case everywhere,
navigation and page titles included. British English. Dates read `8 Oct 2026` (`en-GB`, short month).

## Never

Pill or chip badges (`rounded-full` tinted labels), icon tiles (an icon in a tinted rounded square),
pulsing "live" dots, gradient washes, glows, blurred orbs, coloured top stripes, macOS traffic-light
dots, sparkle icons, uniform grids of identical stat cards, tiny spaced capitals. Type, rules and
alignment do that work.
