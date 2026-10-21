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
- **One page column** (`PAGE_COLUMN` in Layout): the header's title and actions sit on the same left
  and right edges as the panels below. Header and main both reserve the scrollbar gutter.
- **The sidebar's control** is a round handle half way down the seam, never beside the logo: shown
  while the pointer is over the sidebar, always on touch screens and when collapsed; `[` toggles it.
  One set of markup serves both widths — labels fade and the wordmark is clipped into the mark, but
  icons never move. The logo is the link home.
- **Phones (below 768px)**: a 56px top bar on the canvas — the logo home on the left, a menu button on
  the right — stands in for the sidebar, which opens as a modal drawer (focus held inside; Escape, the
  backdrop or following a link closes it and returns focus to the button). The sheet runs edge to edge
  under a hairline, and the page column's gutter is 16px. A table wider than the screen scrolls inside
  its panel; a grid list drops columns instead (the VM list keeps name and status — the row opens the
  VM, and every action is on its page). Segmented options keep to one line and the track scrolls.
  Fields read at 16px on touch screens so iOS never zooms the page on focus.

## Primitives — use these, don't restyle per page

| Need | Use |
|---|---|
| A boxed group with a title | `<Panel>` + `<PanelHeader title meta actions />` (title bar = 48px, label left, readouts/actions right) |
| A row of numbers (counts, totals) | `<StatStrip>` + `<Stat label value sub tone />` — ONE ruled strip, never a grid of identical cards. Only for figures the rows below don't already show (VMs, Backups, Storage); a short list carries its count and total in its own foot (`<tfoot>` / a `bg-surface/60` foot row, the total under its column) |
| A section of the page | `<SectionHeading label="…" />` (label + steel tick + hairline) |
| VM state | `<StatusBadge status />` / `<StatusGlyph status />` — the glyph *shape* encodes state (disc running, ring stopped, bars paused, diamond crashed) |
| A warning that isn't a VM state | `<WarnGlyph />` |
| A proportion of a whole | `<RingGauge value tone>` (the logo ring) — dashboard; or a 5px bar on `bg-gauge-track` |
| Buttons | `<Button variant="primary\|secondary\|ghost\|danger\|dangerOutline" size="sm\|md">` — primary is **ink** (`bg-action`), not steel, and marks the one main action of a view; actions repeated down a table are `secondary`. Page-header actions are `md` (36px) everywhere; dialog footers use `sm` |
| Several related commands behind one button (a row's power actions) | `<Menu label tooltip icon items>` — portalled, keyboard-complete; graceful commands above forceful ones (`separated`), destructive ones `danger`. Pass `tooltip` to the Menu, never wrap it in `<Tooltip>` (React counts the portal as inside the wrapper) |
| A quiet action on a table row (detach, rename, delete) | `<RowAction label tooltip danger>` (`components/ui/RowAction.tsx`): a ghost icon button, red only on hover when `danger`; the tooltip may say when or why, the label says what |
| Tabs/filters with 2–6 options | `.segmented` container, `aria-pressed` on the chosen `<button>` |
| A note between fields or above a table | `<Callout tone="info\|warn" lead>` (`components/ui/Callout.tsx`); class strings `CALLOUT_INFO` / `CALLOUT_ATTENTION` for the same recipe. Never a one-off tinted box |
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
  one, a single action. No icon tile above it — a plain 20px muted icon at most. A secondary panel on
  a tab (port forwards, firewall rules, devices) says it in one left-aligned line (`px-5 py-3.5`)
  instead of reserving a block; a panel with nothing to act on (Boot order with one device) is not drawn.
- **Tabs** (VM detail): underline tabs — 13.5px medium, muted at rest, ink when active with a 2px
  steel underline (`border-primary`); the bar sits on a full-width hairline.
- **Row actions**: ghost icon buttons (`h-8 w-8 rounded-md text-muted-foreground hover:bg-muted
  hover:text-foreground`), destructive ones `hover:text-destructive hover:bg-destructive/10`;
  every icon-only button has `aria-label` and a `<Tooltip>`. A VM row has one power control — Power on
  when stopped, the power `<Menu>` when running — so every state's icons share the same columns.
- **One ink action per view** includes tab panels: on a VM's tabs the header's Console / Power on is
  the ink action, so a panel's own Add / Take snapshot is `secondary`. Dialog confirm buttons stay ink.
- **Saving a section** (Settings, a VM's boot order): Save is `secondary` and disabled until the fields
  differ from what is saved, and turns ink while there are unsaved changes. Destructive confirmations
  use `<Dialog>` with a `danger` button — never the browser's `confirm()`.
- **Dialogs hold the keyboard**: `<Dialog>` is portalled to `<body>`; focus moves in when it opens (to its
  first text field, or else to the panel itself — never straight onto a destructive button), Tab stays
  inside, Escape closes the top one, and focus returns to whatever opened it.
- **A disabled control says why in words** a touch or keyboard user can see — the panel's meta or a muted
  line beside it — not only in a tooltip. Tooltips show on hover and on keyboard focus (`:focus-visible`),
  never on focus a script hands back after a click.
- **Every VM action is on the VM's page**, Delete included (the trash button after Clone), because a
  phone's list shows no row actions. The console's toolbar uses the same words (Power on, Reboot, Power
  off, Force off), and any page about one VM (its own, its backup history) shows its mark by its name.
- **Lists of outcomes are quiet when things went right**: a succeeded log row's icon is muted, so a
  failure is the only colour. A review step is ruled sections inside the step's panel — no boxes in the
  box — and reads from the same rows as the summary beside it.
- **Keys and values**: label column `text-[12.5px] text-muted-foreground`, value `font-mono text-[12px]
  text-foreground`, rows ruled with `divide-y divide-border`.
- **Tables fit at 1024 with the sidebar open** (a 702px column; measure `scrollWidth`, since shots hide
  scrollbars and clipping). Narrower, a table scrolls inside its panel (`.panel:has(table)` in
  `index.css`, at every width); it never clips the row actions. A path wraps only after a slash
  (`PathText`); a setting such as a directory's default is a muted "(default)" beside the item, not a
  column of its own.
- **Clickable rows**: when a row opens something, the name's link is stretched over the row
  (`after:absolute after:inset-0`, row `relative`) and the actions cell sits above it (`relative z-10`).
  One tab stop per row. A row's hover must never promise a click that does nothing.
- **Fields**: one label style (13px semibold), 36px controls everywhere (fields, buttons, `.segmented`,
  the OS-logo picker), `<SearchInput>` for every search, and every `<select>` gets the drawn chevron from
  `index.css`. A label's aside — "(optional)", a unit, "(leave blank for any)" — is muted, never bold:
  `<Input>`/`<Select>` do it from the label text (`LabelText`). Numbers are typed: no native spinners.
  A time of day is one `type="time"` field whose label says whose clock; it clears like any native
  field (give it `''` back while a segment is blank, or React writes the old time straight in) and Save
  waits with the note "Choose a time." A one-of-many choice is a radio, not a toggle button. Help text
  is 12px or more; callouts 12.5px.
- **Dialog footers**: Cancel is always `secondary`; the confirm is ink, or `danger` for a destructive act.
  A confirm disabled for a reason the user can fix says why in the footer (`<Dialog note>`), as the
  wizard's Continue does. Confirmation titles are verb + noun ("Delete virtual machine"), never a question,
  with the object named in the description or body.
- **Checkboxes are drawn once** in `index.css` (16px, the field's material, steel with a tick when chosen);
  never size them per call site. A radio, range or progress keeps the steel `accent-color`.
- **One ink action per view**: e.g. the VM header's Power on (stopped) or Console (running). Groups of
  related actions are separated by a 1px rule, not by colour.
- **OS logos** are one-colour marks in `text-muted-foreground`, never tiles; brand colour appears only in
  the logo picker, where recognising a distro is the point. A VM, template or ISO shows the mark its
  image's filename implies (`osSlugFromImage`) until someone picks one.
- **Live data says when it stopped**: if samples stop arriving the page states "No data since …", the
  verdict becomes "Status unknown" and gauges go muted. Nothing ticks while data is fresh.
- **Charts**: hover (or tap) shows a hairline, a dot per series and the exact values at that moment.
  Byte-rate axes have a 1 KB/s floor (`minMax`) and climb a binary ladder (512 KB/s, 1 MB/s…), so
  ticks are round in the units the formatter prints. A single series has a flat 6% wash under its
  line; a pair has none (one line is dashed). No gradients.
- **The dashboard reads in one order**: the status band; the Host and Virtual machines panels (their
  feet share rules); Host metrics; then one Updates panel — VirtPilot's own row, then the host's
  packages. A fact the band states (acceleration, the version's state) is not repeated beside it.
- **A VM's page is its instrument**: its OS mark beside the name, live readings on the Overview while it
  runs (the allocation as sub-lines; the allocation itself once stopped), and every power state has a
  control (Force off for paused or crashed).

## Devices (passthrough)

- **What can't be used is not offered.** The host's Devices list and the Attach device picker show only what a VM could
  be given; chipset plumbing, bridges, hubs and anything the host needs sit behind one muted line in the panel's foot
  ("206 more devices aren't offered: 3 the host needs, …" + Show them), each with its reason. Identical rows (a CPU's
  dozens of register functions) collapse into one with a count.
- **One table, a heading row per kind** (`th scope="rowgroup"`, `bg-surface/60`, 12px medium muted): GPUs and graphics
  cards, network cards, storage controllers, USB controllers, accelerators, audio, other, USB devices. The picker uses the
  same rows inside one ruled box; never a box per group.
- **A device reads the same everywhere** (`components/devices/DeviceBits.tsx`): name; kind · vendor; facts joined with
  " · " that never break inside a fact; then its notes (attention amber with the warning glyph, information muted). A GPU
  goes by its product ("NVIDIA L4"), lspci's chip codename is a fact, and vendors drop their company suffix; the name
  doesn't repeat the vendor.
- **Cells that sit side by side are two lines each**: Address over Group; Used by is the VM (a link) over its state glyph
  and word, or "Host" over the driver in mono, or "Kept for VMs" over `vfio-pci`.
- **A check panel with nothing to act on folds to one line** ("Ready for PCI and USB" + Show checks); anything off opens it,
  amber, with what to change under the value.
- **The picker is radio rows.** A row that can't go to this VM is disabled with the reason in a muted line under it (given to
  another VM, too large for BIOS firmware); the footer note says what the choice will do, or why Attach is waiting.
- **A VM's devices tab is quiet when settled**: no state column. A pending change or a device that left the host is a note
  under its name; Detach is a ghost row action (unplug icon, red on hover) whose tooltip says when it applies, and a
  pending detach shows Undo instead.

## The console window

- **One window** (`virtpilot-console`) for every Console button. A click for a VM the window already shows
  brings its tab forward; any other VM opens a tab. The request travels in the fragment (`#open=<uuid>.<time>`),
  a same-document navigation: navigating the window to a URL would reload it and end every session in it.
- **Always dark.** The document takes `.dark` while the console is open, so portalled menus, tooltips and
  toasts match; the app's theme comes back on the way out.
- **Header (48px)** speaks for the active tab: its VM (a back link outside a popup; the OS mark from 640px),
  the VM's state, the focused pane's kind (`.segmented` Console / SSH / VNC: choosing another starts that
  kind of session in its place), the connection word (coloured only when something is wrong; "Not connected"
  while a stopped VM is waited for), then Send keys (VNC only, once connected), power (Power on, or the
  power `<Menu>`) and the theme menu (radio items with swatches).
- **Tab strip (40px)** on the canvas. The selected tab takes the terminal theme's ground and runs into the
  pane, as a desktop terminal's does. A tab carries its kind's icon, amber or red when its session is in
  trouble; new output in a background tab turns its label ink and semibold. Never a dot. `+` opens the same
  VM and kind; the chevron menu opens any VM ("Open SSH on"). Two tabs that would read the same are numbered.
  Splits (right, down, up to four panes) sit at the strip's right and are hidden on phones.
- **A pane that can't run says so in a floating bar** at its top: "Session ended" or "Couldn't connect" with
  the reason and Reconnect, or "web-01 is stopped" with Power on. Never a whole-page panel: the scrollback
  stays readable and selectable around the bar.
- **Terminal**: JetBrains Mono 13px; the margin is padding on xterm's own `.xterm` element and the fit takes
  it off before counting cells; columns are `floor()`ed from the measured cell.

## Numbers and words

- One set of formatters in `lib/format.ts` — `formatBytes`, `formatMemory`, `formatRate`, `formatDuration`,
  `formatDate`, `formatDateTime`, `formatChartTime`/`formatChartMoment`, `formatUptime`. At most one decimal,
  no trailing `.0`, a space before every unit ("1 GB", "1.5 GB", "237 ms"); dates `8 Oct 2026, 16:33`.
- Quantities are Inter with `tabular-nums`, right-aligned in tables; JetBrains Mono is for identifiers.
  Sizes always go through `formatDisk` / `formatBytes` / `formatMemory`, never `{x} GB` by hand.
- A figure the source can't give is labelled for what it is: a guest without balloon stats shows the
  memory the host has given it, "resident on host", never its allocation as "100% used"; a size nobody
  measured (an internal snapshot taken offline) is "Not measured", never "0 B".
- **No long dashes (— or –) in anything a user reads**: the UI, server messages, installer and upgrade
  output, the README, the CHANGELOG and the release notes. The owner reads them as machine-written. Where a
  dash would go, a spaced hyphen ("Cloning - this copies the full disk"); in a range, a hyphen ("1-28").
  A value that isn't there is a word, never a dash: "…" while it loads (muted; `Stat` does it), "Never", "None", "0" or "0 B" for
  nothing counted, "any", "Not set" (an unfilled wizard field), "No media", "Not measured", "Unknown";
  an empty optional field (a description) is left blank. `node scripts/check-dashes.mjs` enforces it in
  CI; code comments are exempt.
- Say a fact once: a number shown in a gauge is not repeated in the verdict beside it.
- Subtitles say what the page holds, in one sentence with a full stop — never "Manage …". The browser
  tab reads "Page · host · VirtPilot" (`docTitle` for pages that draw their own header).

## Colour

- Text: `text-foreground` (ink/frost), `text-muted-foreground` for secondary. No faded text below
  `/80`; it fails contrast. Light-theme coloured text uses 700 shades with a `dark:` 300 pair
  (`text-emerald-700 dark:text-emerald-300`).
- Steel (`text-primary`, `border-primary`, `bg-accent`, `ring`) marks what the eye should follow:
  focus, selection, links, the active nav item's icon, data series. It is NOT the primary button.
- Status: green = running/healthy, amber = attention, red = failed/destructive. Solid red only on the
  button that confirms a destructive act.
- A type is not a state: network types (`networkTypeLabel` in `lib/format.ts`, the same words on every
  page), storage purposes, defaults, a guide's difficulty and other categories are plain text, never
  coloured (a green "Bridge · static" reads as healthy). A backup's consistency is a word too; only
  "No guest agent" carries the warning mark, and the notes under a backup are muted explanations.
- Mono chips in prose are for what someone types (addresses, interfaces, commands); a button or option
  named in instructions is a bold word.
- Charts: `lib/chartColors.ts` (CPU steel, memory heather, inbound steel / outbound ochre dashed).

## Type

Inter (opsz build: headline sizes switch to Inter Display, the wordmark's face) + JetBrains Mono for
identifiers (IDs, paths, MACs, IPs, versions). Page title 26px/600; panel title 13.5px/600; body 13.5px;
labels 12–12.5px/500 muted; readouts 26px/600 tabular. Nothing below 11px (mono identifiers and axis ticks); labels 12px+. Sentence case everywhere,
navigation and page titles included. British English. Dates read `8 Oct 2026` (`en-GB`, short month).

## Never

Pill or chip badges (`rounded-full` tinted labels), icon tiles (an icon in a tinted rounded square),
pulsing "live" dots, status dots before words that aren't a VM's state (Healthy, Up to date, Live,
Connected), gradient washes (charts included), glows, blurred orbs, coloured top stripes, macOS
traffic-light dots, sparkle icons, uniform grids of identical stat cards, tiny spaced capitals, long
dashes in user-facing text. Type, rules and alignment do that work.

## Traps

- A disabled `<Menu>` item keeps its text readable (muted, never an opacity fade): its hint is where it says why.

- `.animate-fade-up` fills `backwards`, never `both`: a transform kept after the animation makes the
  section the containing block of every `position:fixed` child (dialogs, terminals).
- Tailwind emits `.h-dvh` before `.h-screen`, so the pair resolves to 100vh. The window height is
  `.app-frame` (`100vh` then `100dvh` in one rule).
- A portalled popover inside a `<Tooltip>` keeps the tooltip showing (React counts the portal as
  inside the wrapper): give the popover's trigger its own tooltip, as `<Menu tooltip>` does.
- A scrolling tab bar clips a tab's `-mb-px` underline over a real border: draw the bar's hairline as
  an inset shadow.
- The serial console is one reader per VM: a second `virsh console --force` kicks the first ("stream had I/O
  failure"). The backend shares one per VM (`console.ts`); never spawn one per socket.
- A pane in a hidden tab measures 0×0. Fitting then squeezes the pty to two columns and reflows the guest's
  screen: skip the fit, the ResizeObserver fires again when the tab shows.
- A menu over a terminal must not close on any scroll: the terminal's viewport scrolls with every line it
  prints. `<Menu>` closes only on a scroll that moves its button.
- noVNC reports no close reason, so a VNC pane can only say "Session ended" or "Couldn't connect".
