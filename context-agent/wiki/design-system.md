# Design system

How every screen of the Autocatalyst web client looks. Read this before building or changing a screen.
It holds the tokens, the shell regions and dimensions, the alignment rules, the component rules the
concepts do not state, and the geometry assertions that check them. What the screens do is in
`context-human/concepts/ux.md`, `collection.md`, and `run-detail.md`. Once code exists for a token or
component, the code is authoritative for implementation detail and this file is authoritative for the rule.
Change this file in the same change that changes a token, a shell dimension, or a shared component.

The rules assume this stack: React 19, Tailwind 4, Base UI (`@base-ui/react`) primitives, lucide-react
icons, shiki for code, Vitest for component tests, and Playwright for end-to-end and geometry tests.

## Principles

- The client is dense and keyboard-first: text is 11 to 14 px, rows are 28 to 36 px, and every action has a
  key.
- Tokens are the only source of color, size, radius, and motion. Components use the semantic tokens
  (`--color-text`) and never a literal value or a raw palette name (`--ctp-*`).
- One primary-filled control is on screen per bar. The primary fill means "this needs you" or "this is the
  decision".
- Color is never the only signal. It comes with a word, a shape, or an underline.
- A divider appears only where it separates regions that need separating. Space does the rest.

## Tokens

All tokens are CSS custom properties, declared in the Tailwind 4 `@theme` block, and exposed as utilities
(`bg-background`, `text-subtext`, `h-control-base`). Theme values come from the active theme block,
selected by `data-theme` on the `html` element.

### Color

Colors come from the operator's chosen theme. A theme is a light or dark palette, and every theme defines
every token below with a value for its own brightness. Components read only these tokens. Light and dark
appearances are two themes, picked in Appearance settings (theme mode, light slot, dark slot).

| Token | Role |
| --- | --- |
| `--color-background` | Main area, detail pane, table. |
| `--color-mantle` | Sidebar, footer, cards, code and diagram backgrounds. |
| `--color-crust` | Dim backing behind dialogs. |
| `--color-surface` | Selected row, hover fill, pressed secondary button. |
| `--color-surface-1` | Hover on a surface, upcoming progress segment. |
| `--color-surface-2` | Strong fill, placeholder outlines. |
| `--color-overlay` | Muted icons, canceled and untested dots. |
| `--color-text` | Primary text. |
| `--color-subtext-1` | Tertiary text. |
| `--color-subtext` | Secondary text, labels, counts. |
| `--color-primary` | Focus, selection, links, active tab, primary action. Set from the primary accent. |
| `--color-secondary` | Second accent for neutral highlights. Set from the secondary accent. |
| `--color-on-primary` | Text on a primary fill. |
| `--color-on-destructive` | Text on a red fill. |
| `--color-border` | Borders and dividers. |
| `--color-focus` | Focus ring. Equals the primary accent. |
| `--color-green` | Done, pass, resolved. |
| `--color-red` | Failed, fail, connection lost, destructive. |
| `--color-yellow` | Open comment marker, caution. |
| `--color-mauve`, `--color-peach` | Decorative pairings only. |

Derived tokens are mixes of the tokens above, defined once in the token layer so no component picks its
own opacity:

- `--color-border-subtle` and `--color-border-faint`: weaker forms of `--color-border`.
- `--color-hover` and `--color-hover-row`: weak forms of `--color-surface`, for sidebar and row hover.
- `--color-secondary-highlight-bg`, `-border`, and `-text`: a muted hint treatment from the secondary accent.
- `--color-sentiment-good-*`, `-ok-*`, and `-bad-*` (`bg`, `border`, `text`): tints of green, yellow, and
  red. Text is `--color-text`.
- `--color-comment-open-bg`, `--color-comment-open-line`, `--color-comment-resolved-bg`,
  `--color-comment-selected-bg`, and `--color-comment-flash-bg`: the comment marker fills and the open
  underline.

Color rules:

1. The primary accent is for user intent: focus, the selected tab, links, the active view chip, the decision
   button, and the "Waiting on you" chip.
2. The secondary accent is for neutral highlights, such as a hint chip. It is never a status color.
3. Status uses `--color-green`, `--color-red`, and `--color-overlay`. Sentiment tokens need visible text
   beside them.
4. Gray carries "not applicable": canceled, not started, skipped, untested.

Contrast rules, checked in every theme:

- Text against its background meets 4.5:1. Large text (18 px and up, or 14 px bold) meets 3:1.
- Interactive component boundaries, icons that carry meaning, and the focus ring meet 3:1 against the
  adjacent color.
- `--color-on-primary` meets 4.5:1 on `--color-primary`, and `--color-on-destructive` meets 4.5:1 on
  `--color-red`, for every accent the operator can pick.
- Disabled controls are exempt.

### Themes and accents

The catalog has eight themes. Light slot: Catppuccin Latte, GitHub Light, Solarized Light. Dark slot:
Catppuccin Frappe, Catppuccin Macchiato, Catppuccin Mocha, GitHub Dark, Dracula. The `html` element carries
`data-theme` (the resolved theme id), `data-theme-mode` (`light` or `dark`), `data-primary-accent`, and
`data-secondary-accent`. Theme mode `system` follows `prefers-color-scheme`.

Fourteen accent ids exist: rosewater, flamingo, pink, mauve, red, maroon, peach, yellow, green, teal, sky,
sapphire, blue, lavender. Each theme defines `--accent-<id>`. `--primary-accent` and `--secondary-accent`
point at the chosen ids, and `--color-primary` and `--color-secondary` read them. The defaults are sapphire
and teal. Sentiment tokens do not follow the accents. Shiki uses the code theme that matches the resolved
theme's brightness.

### Type

| Token | Value | Use |
| --- | --- | --- |
| `--font-sans` | `"Inter Variable", ui-sans-serif, system-ui, sans-serif` | All interface text. The operator can change it in General. |
| `--font-mono` | `"Fira Code", ui-monospace, monospace` | Code, identifiers, step names. The operator can change it in General. |
| `--text-xs` | `0.6875rem` (11 px) | Chips, counts, column headers, hints. |
| `--text-sm` | `0.75rem` (12 px) | Sidebar rows, footer text, buttons, settings labels. |
| `--text-base` | `0.8125rem` (13 px) | Body text, table cells, spec text. |
| `--text-md` | `0.875rem` (14 px) | Row titles, header titles, sidebar title. |
| `--text-lg` | `1rem` (16 px) | Run title in the pane, settings page title. |
| `--text-xl` | `1.25rem` (20 px) | The spec document title only. |

Line heights: 20 px for `--text-sm` through `--text-md`, 16 px for `--text-xs`, 1.3 for headings, 1.6 for the
spec document. Weights: 400 for text, 500 for titles, chips, and buttons, 600 for page and section
headings. Numbers that change (counts, durations, ages, positions) use `tabular-nums`.

### Spacing, control heights, radius

The base unit is 4 px (`--spacing: 0.25rem`). Use the Tailwind scale that derives from it. Horizontal
padding of rows and bars is 12 px, and the detail pane body padding is 16 px.

| Token | Value | Use |
| --- | --- | --- |
| `--height-control-sm` | 1.5rem (24 px) | Chips, the decision button, icon buttons in bars. |
| `--height-control-base` | 1.75rem (28 px) | Inputs, default buttons, sidebar rows. |
| `--height-control-lg` | 2rem (32 px) | Large buttons, dialog primary actions. |
| `--radius-xs` | 2 px | Comment highlights, progress segments. |
| `--radius-sm` | 4 px | Buttons, inputs, cards, rows, code blocks, popovers, dialogs. |
| `--radius-full` | 9999 px | View chips, status dots. |

### Elevation, layers, motion, icons

Flat surfaces separate with a border. Only floating surfaces cast a shadow: menus, popovers, the selected
comment card, the composer, and the hover sidebar use `--shadow-popover`, and dialogs use `--shadow-dialog`.
The theme sets both.

Stacking order, lowest first: the shell, the hover sidebar, the full-screen overlay, then menus, popovers,
and dialogs. The order matters because the hover sidebar covers the header and footer, and a menu opens
above the overlay.

Motion tokens: `--duration-hover` (100 ms) for hover and pressed, `--duration-enter` (150 ms) for entrances
and fades, `--duration-exit` (100 ms), and `--duration-layout` (250 ms) for sidebar and pane open and close.
Use hover or enter by default. With `prefers-reduced-motion`, durations are 0 and the running-step spinner
is a static icon.

Icons are lucide-react only: 16 px in menus, 14 px in rows, bars, and the footer, 12 to 13 px in small
affordances, 11 px inside chips and column headers. An icon-only button has an `aria-label` and a tooltip.

## Density

A view sets row density to compact or regular, and regular is the default. Density changes collection rows
only. Bars, the sidebar, the table column header row, and group headers keep their size.

- `--height-row-compact` is 1.75rem (28 px).
- `--height-row-regular` is 2.25rem (36 px).

## The shell

The shell fills the viewport and does not scroll. The sidebar and the main area stack above the footer, and
the footer spans the full width.

| Region | Position | Size |
| --- | --- | --- |
| Sidebar | Left column, above the footer. | `--width-sidebar` wide. Its title row is `--height-header-bar` high. |
| Header | Top of the main area, right of the sidebar. | Title row `--height-header-bar`, then for run views a chips row `--height-chip-row`. |
| List | Below the header, left of the detail pane. | Column header row `--height-pane-bar`, then rows. |
| Detail pane | Below the header, right of the list. | Pane bar `--height-pane-bar`, then the pane body. |
| Footer | Bottom, full width. | `--height-footer` high, five zones. |

The footer has five zones, left to right:

| Footer zone | Holds | Edges |
| --- | --- | --- |
| Left control zone | The sidebar toggle. | Starts at the viewport left edge. Its width is `--width-footer-control`. |
| Sidebar zone | Sidebar-related status, when there is any. | With the sidebar open, ends at the sidebar's right edge. Zero width when closed. |
| List zone | Status for the list: counts and the connection item. | Ends at the list's right edge. |
| Detail pane zone | Information for the pane, such as comment counts. | Starts at the detail pane's left edge and ends where the right control zone starts. |
| Right control zone | The detail pane toggle. | Ends at the viewport right edge. Its width is `--width-footer-control`. |

The control zones sit under the outer ends of the sidebar and the detail pane. They keep their width
whether the sidebar or the pane is open, closed, or hidden. Footer content is centered within its zone.

### Dimensions

| Token | Value | Use |
| --- | --- | --- |
| `--width-sidebar` | 15.25rem (244 px) | Open sidebar and hover sidebar. |
| `--width-footer-control` | 2.75rem (44 px) | Minimum width of the left and right footer control zones. |
| `--height-header-bar` | 2.5rem (40 px) | Header title row and sidebar title row. |
| `--height-chip-row` | 2rem (32 px) | View chips row and the To do slot in the sidebar. |
| `--height-pane-bar` | 2.25rem (36 px) | Table column header row, detail pane bar, spec overlay top row. |
| `--height-footer` | 1.75rem (28 px) | Footer. |
| `--width-resize-handle` | 0.25rem (4 px) | Handle between the list and the side pane. |
| `--width-pane` | 440 px default, 320 px minimum, 720 px maximum | Side detail pane. At most 60% of the main area, so the list keeps room for its title column. |
| `--height-pane` | 280 px default, 200 px minimum, 560 px maximum | Bottom detail pane. At most 70% of the main area, so the list keeps a few rows. |
| `--width-comment-column` | 11rem (176 px) | Comment column beside the spec. |
| `--width-reading-column` | 46rem (736 px) | Maximum width of the spec text. |
| `--width-settings-column` | 42rem (672 px) | Settings page content. |
| `--width-hover-zone` | 0.5rem (8 px) | Left-edge strip that reveals the closed sidebar. |

The sidebar width and the list and pane split are defined once, as these tokens and the pane width state.
Every region reads them, and none computes its own copy.

### Header

The title row is one line: the breadcrumb (when there is one), then the title, on one text baseline. The
breadcrumb is `--text-sm` in `--color-subtext`, separated by `/`. The title is `--text-md`, weight 500,
truncating. Page controls sit at the right end of the row, such as the view settings button for run views.

### Alignment

Region edges and text baselines line up across the shell. The rules hold with the sidebar open or closed,
in every theme, mode, and density, and in settings.

- The header title row and the sidebar title row share top and bottom edges. Their text uses the same size,
  weight, and line height, so the baselines match.
- The To do slot and the view chips row share top and bottom edges. The To do row and the chips are
  vertically centered in that shared height.
- The table column header row and the detail pane bar start at the header's bottom edge and share one
  height. Both use `--text-xs`, so their baselines match.
- The sidebar's bottom edge meets the footer's top edge, and the sidebar divider stops there.
- The sidebar zone's right edge equals the sidebar's right edge. The list zone's right edge equals the
  list's right edge, and the detail pane zone's left edge equals the detail pane's left edge, including
  while the pane resizes.
- Text in all five footer zones shares one baseline.
- The sidebar toggle sits at the left end of the left control zone and the pane toggle at the right end of
  the right control zone. Neither moves when the sidebar or the pane opens, closes, or resizes.
- The decision button's right edge is inset from the pane's right edge by the pane's horizontal padding, and
  it is vertically centered in the pane bar.

### Sidebar states

**Open.** The sidebar column is in the layout at `--width-sidebar`. The footer runs under it, and its top
border is continuous across the full width.

**Closed.** The sidebar column has zero width. The header and the main area start at the viewport's left
edge. The sidebar zone has zero width, and the left control zone keeps the toggle. Closing and opening
animate the layout over `--duration-layout`.

**Hover (closed only).** The pointer entering the left-edge strip (`--width-hover-zone` wide, from the top
of the viewport to the footer top) shows the sidebar as an overlay. The overlay:

- is `--width-sidebar` wide, runs the full viewport height, and sits above the header and the footer;
- takes the pointer, so nothing under it receives hover or clicks while it shows;
- draws its own `--color-border` right divider over the full height, and uses `--shadow-popover`;
- closes when the pointer leaves it and focus is not inside it, and on `Escape`;
- does not move the main area.

The strip ends at the footer top so the left control zone stays reachable. `[` toggles the sidebar open and
closed, and `]` shows and hides the detail pane.

Sidebar rows are `--height-control-base` high, `--text-sm`, `--radius-sm`. Rest is `--color-subtext`, hover
adds `--color-hover` fill and `--color-text`, and the active row has `--color-surface` fill,
`--color-text`, and `aria-current="page"`. Counts and row actions never overlap the label.

### Dividers

A divider appears only where it separates regions that need separating: the sidebar's right edge, the
footer's top edge, the header's bottom edge, the list and pane handle, and the bottom of the column header
row and the pane bar. Dividers use `--color-border`, or its subtle and faint forms for lines that recede.
There is no divider between footer zones, between sidebar sections, or between the header's title row and
chips row. The gap between zones separates them. Alignment assertions depend on the divider width: it is
1 px, and the resize handle is `--width-resize-handle`.

## Collection

**View chips.** Chips are `--height-control-sm` high, `--radius-full`, `--text-xs`, weight 500, with 8 px
horizontal padding, max width 12rem with truncation. Active is `--color-primary` fill with
`--color-on-primary` text and `aria-current="true"`. Inactive is a `--color-border` outline on
`--color-surface` with `--color-text` text, and `--color-surface-1` on hover. A trailing plus chip (named
"Create named view") uses the inactive style. The strip scrolls horizontally and does not wrap.

**Table.**
- The column header row is sticky, `--height-pane-bar` high, `--color-background` fill, `--text-xs`, weight
  500, `--color-subtext`, with a `--color-border` line below. The sorted column shows an 11 px arrow.
- A row is `--height-row-compact` or `--height-row-regular` high, with a `--color-border-faint` line below.
  The title cell holds an 8 px status dot, the title in `--text-md` (truncating), and the issue number in
  `--color-subtext` (never truncating). Other cells are `--text-base` in `--color-subtext`. Time columns use
  `tabular-nums`.
- Hover is `--color-hover-row`. The selected row is `--color-surface` with `aria-selected="true"`, and it
  is the only row with that state. Rows are focusable, and `Enter` selects.
- A row's "..." action button is hidden until the row is hovered or has focus inside it.
- The project column is off by default.

**Group headers.** A group header spans the row width, is 28 px high, `--color-mantle` fill, with a chevron,
the label (`--text-xs`, weight 500, `--color-subtext`), and a `tabular-nums` count. It sticks under the
column header while its group scrolls, and `aria-expanded` reports collapse. The list and board layouts use
the same selection, hover, and status dot rules as the table.

## Detail pane

The pane is `--color-background`, fills the main area below the header, and has three preview modes: side
(default), bottom, and full page. Its accessible name is "Run detail".

**Pane bar.** The pane's top row is `--height-pane-bar` high with 12 px horizontal padding and a
`--color-border` line below. It holds, in order: in full page, a "Back to list" button; previous and next run
buttons; the position ("m of n", `--text-xs`, `tabular-nums`, `--color-subtext`); a flexible gap; full screen
(on the Spec and Acceptance tabs when the document is ready); and the decision button while the run waits at a
gate.

**Header and tabs.** The pane body has 16 px padding and scrolls under the pane bar.
- The title is `--text-lg`, weight 500. Clicking it, or the Rename action, turns it into an input with a
  `--color-primary` border. `Enter` saves and `Escape` cancels.
- The meta line under it is `--text-sm` in `--color-subtext`: the issue number, the work kind chip (a
  `--color-border` outline, `--text-xs`, `--color-text`, `--radius-sm`), and the status word. The pane
  header shows no project name.
- The tabs are, in order: Summary, Spec, Acceptance, Activity. A selected tab is `--color-text` with a
  2 px `--color-primary` underline. Others are `--color-subtext`, and `--color-text` on hover. Tab labels
  carry no counts. Every tab is present and enabled on every run.

**Resizing.** The handle between the list and a side pane has `role="separator"` and
`aria-orientation="vertical"`, and a bottom pane's handle uses `horizontal`. Arrow keys on a focused handle
resize by 16 px, and dragging resizes continuously. The handle is `--color-border-subtle`, and
`--color-primary` on hover, focus, and drag. The detail pane zone follows every change.

**Full-screen overlay.** The spec and the testing guide can fill the screen. The overlay covers the whole
viewport, including the footer, with `--color-background` fill and `role="dialog"`. Its top row is
`--height-pane-bar` high with the run title, the position, the decision button, and a close button. The body
has 24 px padding and a centered column. `Escape` closes it, after any confirm popover on top.

**Progress bar.** One segment per workflow stage, from data. A segment is 6 px high with `--radius-xs`:
done is `--color-subtext`, current is `--color-text`, upcoming is `--color-surface-1`. From 6 segments, only
the current segment shows its label, and the others show their number with the label in a tooltip. The bar
never uses the primary fill, because the status chip is the attention signal.

## Spec reading column

The Spec tab shows the document and a comment column side by side. In the side pane the comment column is
`--width-comment-column`. In the full-screen overlay the document column is at most `--width-reading-column`
and the comment column keeps its width.

**Document.** Text is `--text-base` at 1.6 line height in `--color-text`. Selecting text is the only way to
start a comment, and there is no general comment box. `h1` is `--text-xl`, `h2` is `--text-lg`, and `h3` is
`--text-md`, all weight 600. Tables use `--text-sm` with `--color-border` cell borders and a
`--color-mantle` header. Code and diagram blocks use `--color-mantle` or shiki's background, a
`--color-border` outline, `--radius-sm`, `--font-mono` at `--text-sm`, and scroll horizontally.

**Comment markers.** A marker is a highlight on the anchored text with `--radius-xs` and a
`--duration-enter` background transition. It is clickable and selects its comment.

| State | Style |
| --- | --- |
| Open | `--color-comment-open-bg` fill and a 2 px `--color-comment-open-line` underline. |
| Resolved | `--color-comment-resolved-bg` fill and no underline. |
| Selected | `--color-comment-selected-bg` fill and a 2 px `--color-primary` underline. |
| Jump target | `--color-comment-flash-bg`, fading out once, when a comment is reached with the previous and next buttons. |

Open and resolved differ by the underline as well as the color, so the underline is the non-color signal. A
selected marker replaces the open or resolved style until another comment is selected.

**Comment cards.** Cards stand in the comment column, each at the top of its anchor and pushed down so cards
do not overlap. A card is `--color-mantle` fill, `--color-border-subtle` outline, `--radius-sm`, `--text-sm`.
A resolved card is dimmed. The selected card has a `--color-primary` outline and `--shadow-popover`. A card
holds the author, age, and a state chip (open uses `--color-primary`, resolved uses `--color-green`), the
quoted text (left border, `--text-xs`, italic, `--color-subtext`), the body, replies, and a reply input with
Resolve (Reopen on a resolved card). The composer appears at the selection with a quote line, a textarea, a
primary Comment button (disabled while empty), and Cancel, and uses a `--color-primary` outline and
`--shadow-popover`. `Ctrl+Enter` or `Cmd+Enter` submits, and `Escape` cancels.

The detail pane zone shows "N open, M resolved" in `--text-xs` and the previous and next comment buttons.

## Gate decision

The decision is one button, at the far right of the pane bar and of the overlay top row. A run not waiting at
a gate shows no button. A run waiting at the spec or implementation gate shows "Approve" when no comment is
open, and "Request changes (N)" when N comments are open. Resolved comments do not count. A pull request
gate has no button.

Both labels share one style: `--height-control-sm` high, `--radius-sm`, `--text-xs`, weight 500,
`--color-primary` fill, `--color-on-primary` text, with `tabular-nums` for N. Hover and pressed dim the fill
a step each, and focus shows the `--color-focus` ring with an offset. The label changes in place when the
count crosses zero. Activating the button opens a confirm popover under it: `Enter` confirms and `Escape`
cancels. The popover is keyed to the action, so it resets when the label changes. Destructive run actions
(cancel) use an alert dialog whose confirm button is `--color-red` fill with `--color-on-destructive` text.

## Acceptance tab

Each test item has a result group of `aria-pressed` buttons (Pass, Fail, Not tried) and an optional note
field that works with any result. Buttons are `--text-xs`, `--radius-sm`, with a `--color-border` outline
and `--color-subtext` text when unpressed. Pressed Pass has a `--color-green` outline and a
`--color-sentiment-good-bg` fill. Pressed Fail has a `--color-red` outline and a `--color-sentiment-bad-bg`
fill. Pressed Not tried has a `--color-border` outline and `--color-surface` fill. A command in the
instructions sits in a copy block (`--color-mantle` fill, `--font-mono` at `--text-xs`, a copy button that
shows "Copied" in `--color-green`). General feedback is a text area below the items, the one place feedback
is not anchored. The detail pane zone shows the tally and previous and next item buttons in the comment
count style.

## Status and waiting indicators

**Status dot.** An 8 px circle (`--radius-full`) with a tooltip naming the status: in progress is
`--color-primary`, done is `--color-green`, failed is `--color-red`, canceled is `--color-overlay`.

**Waiting chip.** `--text-xs`, `--radius-sm`, no wrap. "Waiting on you" has `--color-primary` fill and
`--color-on-primary` text. "Working" and "Paused" have a `--color-border` outline and `--color-subtext`
text. A run that ended shows a dash.

**Status word.** In the pane meta line: Done in `--color-green`, Failed in `--color-red`, Canceled in
`--color-subtext`, and the waiting chip for a run in progress.

"Waiting on you" is the only primary-filled signal in the run list and the pane header. No tab, count, or
row carries a second attention signal.

**Step markers** (Activity), 14 px: done is CheckCircle2 in `--color-green`, failed is XCircle in
`--color-red`, canceled is XCircle in `--color-overlay`, waiting on you is Hand in `--color-primary`, running
is a spinning Loader2 in `--color-primary`, skipped is MinusCircle in `--color-overlay`, and not started or
not reached is Circle in `--color-overlay`. Skipped and not-reached rows are dimmed.

**Connection.** When the connection is lost or degraded, the list zone shows an 8 px `--color-red` dot and
"Connection lost" in `--color-red`. A healthy connection shows nothing.

## Empty states

An empty state is centered in its region with a title in `--text-md`, one line in `--text-sm` and
`--color-subtext`, and at most one primary button. It says why the region is empty and what happens next. It
has no illustration. Patterns:

- No projects: "Add a project to get started" with an "Add project" button. With no connection set, the
  button opens Connection settings first.
- No runs: says a run starts from a tracked issue and shows a "Start a run" button.
- A tab with nothing to show: says why, with no button. For a work kind without a spec, it explains that
  the work kind has no spec. For a spec not yet written, it says the spec is being drafted and that the
  operator will be asked to review it here.

The detail pane has no empty state while the list has a run.

## Settings pages

Settings replaces the sidebar with a settings sidebar (a title row of `--height-header-bar` with a close
button, then one row per page: General, Appearance, Connection, Projects) and the main area with one page.
The header shows "Settings" as the breadcrumb and the page name as the title. The footer is unchanged. A
page scrolls with 24 px padding and a content column of at most `--width-settings-column`. Its header is a
title (`--text-lg`, weight 600) over a description (`--text-sm`, `--color-subtext`).

**Row pages (General and Appearance).** A setting row has the label (`--text-sm`) and an optional
description (`--text-xs`, `--color-subtext`) at the left and the control at the right, with a
`--color-border` line between rows. These pages apply changes immediately and have no Save button.
General sets the UI font and the code font (`--font-sans`, `--font-mono`). Appearance has theme mode, the
light theme, the dark theme, the primary and secondary accent, and a Preview: a `--color-border` outline
block on `--color-surface` showing a primary link, a primary button, a secondary-accent chip, and good, ok,
and bad status chips. The preview uses the same tokens as the rest of the client.

**Form pages (Connection and Projects).** A form has an action row: the test button at the left, a flexible
gap, a "Saved" confirmation, Cancel (secondary), and Save (primary). Save is disabled until the form is
valid, and Cancel restores the saved values. A field is a label above the control with an optional hint
below. An input is `--height-control-base` high, `--radius-sm`, with a `--color-border` outline,
`--color-background` fill, and `--text-sm`. Projects shows a list, and Add and Edit show one focused form
that replaces the list.

The test button ("Test connection" or "Test credentials") is secondary and disabled while a test runs. Its
result sits above the action row in a `role="status"` region with an 8 px dot and one of four states: Not
tested and Testing (`--color-overlay` dot, `--color-subtext` text), Connected (`--color-green`), or Failed
(`--color-red` error text, then a suggested fix in `--color-subtext` one line below).

**Write-only secret field.** A secret (bearer token, project credential) is a password input with
`autocomplete="off"`. The control never receives a stored value, so it is empty every time the form opens.

- There is no mask, no "stored" badge, no reveal button, and no clear or delete control.
- With no secret stored, the label reads "Bearer token" (or "Credential") and the field is required.
- With a secret stored, the label reads "Bearer token (leave blank to keep existing)", and the same pattern
  applies to "Credential". An empty field keeps the stored secret, and a new value replaces it.
- After a save, the field empties. A failed test of a typed value leaves the value in the field and the
  stored secret unchanged.
- The secret never appears in a URL, a log line, a toast, or an accessible name.

## Overlays, menus, and buttons

Base UI primitives (Menu, Popover, Dialog, Tooltip, Select, Switch, Tabs) supply behavior and focus
handling, and tokens supply the styling.

- Menus, context menus, and popovers: `--color-mantle` fill, `--color-border` outline, `--radius-sm`,
  `--shadow-popover`. Items are 28 px high, `--text-sm`, with the key right-aligned in `--text-xs`, and a
  highlighted item has `--color-surface` fill.
- Dialogs: `--color-background` fill, `--color-border` outline, `--radius-sm`, `--shadow-dialog`, and a
  `--color-crust` backing. A title (`--text-md`, weight 500), one short description, the body, then a
  right-aligned action row with Cancel left of the confirm action.
- Tooltips are required on every icon-only button.
- Primary buttons use `--color-primary` fill and `--color-on-primary` text. Secondary buttons use a
  `--color-border` outline with `--color-surface` hover. Destructive buttons use `--color-red` fill with
  `--color-on-destructive` text. All use `--text-sm`, weight 500, `--radius-sm`, and dim when hovered and
  more when disabled. A disabled icon button uses `aria-disabled` so it keeps its tooltip.

## Focus and keyboard

- Every interactive element shows a `--color-focus` ring on `:focus-visible`, and none shows one on mouse
  focus. Inputs show it on focus.
- Tab order follows the visual order: sidebar, header, list, pane, footer. The list is one tab stop, and the
  arrow keys and `j` and `k` move the selection inside it.
- Every action is registered once with a name, a key, and a rule for when it applies. Menus, tooltips, and
  the shortcuts overlay read the registry.
- A key shows beside its action: in a tooltip as "Label (key)", and at the right of a menu item as a key cap
  (`--font-mono`, `--text-xs`, `--color-subtext`, `--color-surface` fill, `--color-border` outline). macOS
  shows glyphs and other platforms spell the keys ("Ctrl+Shift+K"). A sequence shows a cap per step.
- Single-key shortcuts do not fire in an input, textarea, select, or editable element, while a menu or
  dialog is open, or with a modifier held. The settings toggle (`Cmd+,` or `Ctrl+,`) works everywhere.
- `[` toggles the sidebar and `]` toggles the detail pane. `Escape` closes the top layer: a confirm popover,
  then the overlay, then full page, then settings.
- A control shown on row hover also shows when focus is inside the row.

## Playwright geometry assertions

Playwright checks these with `getBoundingClientRect` on regions located by role and accessible name: the
sidebar (`navigation`), the header (`banner`), the footer (`contentinfo`), the five footer zones (named by
zone), the detail pane (`complementary` named "Run detail"), the resize handle (`separator`), and the chips
(named "Collection views"). Edges match within 0.5 px and text baselines within 1 px. Each assertion runs
with the sidebar open and closed, in light and dark themes, in compact and regular density, and on a run
view and a settings page, unless it names a state. Where a size has a token, the test reads the token and
does not hard-code the number.

Alignment:

- The header title row's top and bottom edges equal the sidebar title row's. Their title text baselines
  match (sidebar open).
- The chips row's top and bottom edges equal the To do slot's, and the active chip's vertical center equals
  the To do row's vertical center (run views, sidebar open).
- The table column header row's top edge equals the detail pane bar's top edge, and both equal the
  header's bottom edge. The two rows have equal heights and matching text baselines.
- The header's left edge equals the sidebar's right edge when open and the viewport's left edge when closed.
  The header's right edge equals the viewport's right edge.

Footer:

- The footer's top edge is the viewport height minus `--height-footer`, and its width equals the viewport
  width. Its top border spans the viewport width.
- The sidebar's bottom edge and the sidebar divider's bottom edge equal the footer's top edge (sidebar open).
- The five zones are contiguous in order, with no gap or overlap, and together span the footer. No zone has a
  left or right border.
- The left and right control zones are at least `--width-footer-control` wide. The sidebar toggle's bounding
  box is the same with the sidebar open, closed, and hovered, and the pane toggle's box is the same with the
  pane shown, hidden, and resized.
- The sidebar zone's right edge equals the sidebar's right edge (sidebar open), and its width is zero when the
  sidebar is closed.
- The list zone's right edge equals the list's right edge. The detail pane zone's left edge equals the detail
  pane's left edge, also after the pane is dragged and after it is resized with the arrow keys.
- Each zone's content center equals the center of its zone, and text in all five zones shares one baseline.

Sidebar behavior:

- With the sidebar closed, moving the pointer into the left-edge strip shows the overlay. Its top and bottom
  edges equal the viewport's, and its width equals `--width-sidebar`. It closes on `Escape` and when the
  pointer leaves it.
- With the overlay showing, `elementFromPoint` at a point in the header and a point in the footer, both
  within the overlay's horizontal range, returns an element inside the overlay. The header, list, and pane
  keep the positions they had with the sidebar closed.
- `[` toggles the sidebar and `]` toggles the detail pane, and the geometry rules above hold after each.
- The resize handle's width equals `--width-resize-handle`, and the pane's left edge equals the handle's
  right edge.
- Nothing between the header title row and the chips row has a border.

Pane, rows, and documents:

- The decision button's right edge is inset from the pane's right edge by the pane's horizontal padding, and
  its vertical center equals the pane bar's.
- A row's height equals `--height-row-compact` or `--height-row-regular` for the view's density. The column
  header row height does not change with density.
- Exactly one row has `aria-selected="true"`.
- The pane width stays within `--width-pane`'s minimum and maximum and within its share of the main area.
- The comment column's width equals `--width-comment-column`. Each comment card's top edge is at or below its
  anchor's top edge and below the card above it.
- The full-screen overlay's box equals the viewport's box and covers the footer.
- The settings content column's width is at most `--width-settings-column`. The settings sidebar title row
  follows the title row alignment assertions above.

Appearance:

- After a theme or mode change, the body background equals the new theme's `--color-background`, and none
  of the geometry above changes.
- In every theme, visible text meets 4.5:1 against its background (3:1 for large text), and meaningful UI
  boundaries and the focus ring meet 3:1, excluding disabled controls.
