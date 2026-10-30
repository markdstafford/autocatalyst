# Design system

How every screen of the Autocatalyst web client looks. Read this before building or changing a screen.
It holds the tokens, the shell dimensions, the component rules, the alignment and divider rules, and the
geometry assertions that check them. What the screens do is in `context-human/concepts/ux.md`,
`collection.md`, and `run-detail.md`. Once code exists for a token or component, the code is authoritative
for implementation detail and this file is authoritative for the rule. Change this file in the same
change that changes a token, a shell dimension, or a shared component.

The rules assume this stack: React 19, Tailwind 4, Radix primitives, lucide-react icons, shiki for code,
Vitest for component tests, and Playwright for end-to-end and geometry tests.

## Principles

- The client is dense and keyboard-first: text is 11 to 14 px, rows are 28 to 36 px, and every action has a
  key.
- Tokens are the only source of color, size, radius, and motion. Components use the semantic tokens
  (`--color-text`) and never a literal value or a raw palette name (`--ctp-*`).
- One primary-filled control is on screen per bar. The primary fill means "this needs you" or "this is the
  decision".
- Color is never the only signal. It comes with a word, a shape, or an underline.
- A divider appears only where it separates two regions that need separating. Space does the rest.

## Tokens

All tokens are CSS custom properties, declared in the Tailwind 4 `@theme` block, and exposed as utilities
(`bg-background`, `text-subtext`, `h-control-base`). Theme values come from the active theme block,
selected by `data-theme` on the `html` element.

### Color

Colors come from the operator's chosen theme. A theme is a light or dark palette, and every theme defines
every token below with a value for its own brightness. Components read only these tokens. No component
holds a color value, and none uses a raw palette name. Light and dark appearances are two themes, picked by
the Appearance settings (theme mode, light slot, dark slot).

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

Derived tokens are mixes of the tokens above, defined once in the token layer so that no component picks
its own opacity:

- `--color-border-subtle` and `--color-border-faint`: weaker forms of `--color-border`, for lines that
  should recede.
- `--color-hover` and `--color-hover-row`: weak forms of `--color-surface`, for sidebar and row hover.
- `--color-secondary-highlight-bg`, `-border`, and `-text`: a muted hint treatment from the secondary accent.
- `--color-sentiment-good-*`, `-ok-*`, and `-bad-*` (`bg`, `border`, `text`): tints of green, yellow, and
  red. Text is `--color-text`.
- `--color-comment-open-bg`, `--color-comment-open-line`, `--color-comment-resolved-bg`,
  `--color-comment-selected-bg`, and `--color-comment-flash-bg`: the comment marker fills and the open
  underline, from yellow, green, and the primary accent.

Color rules:

1. The primary accent is for user intent: focus, the selected tab, links, the active view chip, the
   decision button, and the "Waiting on you" chip.
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
`data-secondary-accent`. Theme mode `system` follows `prefers-color-scheme` and picks the light or dark
slot.

Fourteen accent ids exist: rosewater, flamingo, pink, mauve, red, maroon, peach, yellow, green, teal, sky,
sapphire, blue, lavender. Each theme defines `--accent-<id>`. `--primary-accent` and `--secondary-accent`
point at the chosen ids, and `--color-primary` and `--color-secondary` read them. The defaults are sapphire
and teal. Sentiment tokens do not follow the accents. Shiki uses the code theme that matches the resolved
theme's brightness.

### Type

| Token | Value | Use |
| --- | --- | --- |
| `--font-sans` | `"Inter Variable", ui-sans-serif, system-ui, sans-serif` | All interface text. The operator can change it in General. |
| `--font-mono` | `"Fira Code", ui-monospace, monospace` | Code, identifiers, step names, paths. The operator can change it in General. |
| `--text-xs` | `0.6875rem` (11 px) | Chips, counts, column headers, hints, footer detail. |
| `--text-sm` | `0.75rem` (12 px) | Sidebar rows, footer text, buttons, settings labels. |
| `--text-base` | `0.8125rem` (13 px) | Body text, table cells, spec text. The `body` size. |
| `--text-md` | `0.875rem` (14 px) | Row titles, header titles, sidebar title. |
| `--text-lg` | `1rem` (16 px) | Run title in the pane, settings page title. |
| `--text-xl` | `1.25rem` (20 px) | The spec document title only. |

Line heights: 20 px for `--text-sm` through `--text-md`, 16 px for `--text-xs`, 1.3 for headings, 1.6 for the
spec document. Weights: 400 for text, 500 for titles, chips, and buttons, 600 for page and section
headings. Numbers that change (counts, durations, ages, positions) use `tabular-nums`. Uppercase with
`tracking-wide` is for sidebar section headings only.

### Spacing and control heights

The base unit is 4 px (`--spacing: 0.25rem`). Use the Tailwind scale that derives from it: 4 px between a
chip and its neighbor and for the resize handle, 6 px for sidebar and footer inner padding, 8 px between an
icon and a label, 12 px for horizontal padding of rows and bars, 16 px for pane body padding, 24 px for
settings page padding.

| Token | Value | Use |
| --- | --- | --- |
| `--height-control-sm` | 1.5rem (24 px) | Chips, the decision button, icon buttons in bars. |
| `--height-control-base` | 1.75rem (28 px) | Inputs, default buttons, sidebar rows. |
| `--height-control-lg` | 2rem (32 px) | Large buttons, dialog primary actions. |

### Radius

| Token | Value | Use |
| --- | --- | --- |
| `--radius-xs` | 2 px | Comment highlights, progress segments. |
| `--radius-sm` | 4 px | Buttons, inputs, cards, rows, code blocks, popovers, dialogs. |
| `--radius-full` | 9999 px | View chips, status dots, the count badge. |

### Elevation and layers

Flat surfaces separate with a border. Only floating surfaces cast a shadow: menus, popovers, the selected
comment card, the composer, and the hover sidebar use `--shadow-popover`, and dialogs use `--shadow-dialog`.
The theme sets both for its brightness.

Stacking order, lowest first: the shell, the hover sidebar, the full-screen overlay, then menus, popovers,
and dialogs. The order matters because the hover sidebar must cover the header and footer, and a menu must
open above the overlay.

### Motion

`--duration-hover` is 100 ms (hover and pressed), `--duration-enter` is 150 ms (entrances, fades, highlight
background), `--duration-exit` is 100 ms, and `--duration-layout` is 250 ms (sidebar and pane open and
close). Use hover or enter by default, and layout only for a change the operator asked for. With
`prefers-reduced-motion`, durations are 0 and the running-step spinner is a static icon.

### Icons

lucide-react only. 16 px in the sidebar rail and menus, 14 px in rows, bars, and the footer, 12 to 13 px
in small affordances (chevrons, the pin, previous and next arrows), and 11 px inside chips and column
headers. An icon-only button has an `aria-label` and a tooltip with the key when one exists.

## Density

A view sets row density to compact or regular. Density changes collection rows only. Bars, the sidebar,
the table header row, and group headers keep their size. Regular is the default. Rows have 12 px
horizontal padding in both.

- `--height-row-compact` is 1.75rem (28 px): a 20 px line plus 4 px above and below.
- `--height-row-regular` is 2.25rem (36 px): a 20 px line plus 8 px above and below.

## The shell

The shell fills the viewport and does not scroll. The sidebar and the main area stack above the footer,
and the footer spans the full width.

| Region | Position | Size |
| --- | --- | --- |
| Sidebar | Left column, above the footer. | `--width-sidebar` wide. Its title row is `--height-header-bar` high. |
| Header | Top of the main area, right of the sidebar. | Title row `--height-header-bar`, then for run views a chips row `--height-chip-row`. |
| List | Below the header, left of the detail pane. | Column header row `--height-pane-bar`, then rows. |
| Detail pane | Below the header, right of the list. | Navigation row `--height-pane-bar`, then the pane body. |
| Footer | Bottom, full width. | `--height-footer` high, five zones. |

The footer has five zones, left to right: left control zone, sidebar zone, list zone, detail pane zone, right
control zone.

| Footer zone | Holds | Edges |
| --- | --- | --- |
| Left control zone | The sidebar toggle. | Starts at the viewport left edge. Its width is `--width-footer-control`. |
| Sidebar zone | Sidebar-related status, when there is any. | With the sidebar open, ends at the sidebar's right edge. Zero width when closed. |
| List zone | Status for the list: counts and the connection item. | Ends at the list's right edge. Content is centered between its own edges. |
| Detail pane zone | Information for the pane: comment counts and previous and next buttons. | Starts at the detail pane's left edge and ends where the right control zone starts. Content is centered. |
| Right control zone | The detail pane toggle. | Ends at the viewport right edge. Its width is `--width-footer-control`. |

The control zones are minimum-width zones that sit over the outer ends of the sidebar and the detail pane.
They keep the same width whether the sidebar or the pane is open, closed, or hidden. Zones have no
dividers between them.

### Dimensions

| Token | Value | Use |
| --- | --- | --- |
| `--width-sidebar` | 15.25rem (244 px) | Open sidebar and hover sidebar. The sidebar zone ends where the sidebar ends. |
| `--width-footer-control` | 2.75rem (44 px) | Minimum width of the left and right footer control zones. |
| `--height-header-bar` | 2.5rem (40 px) | Header title row and sidebar title row. |
| `--height-chip-row` | 2rem (32 px) | View chips row and the To do slot in the sidebar. |
| `--height-pane-bar` | 2.25rem (36 px) | Table column header row, pane navigation row, spec overlay top row. |
| `--height-footer` | 1.75rem (28 px) | Footer. |
| `--width-resize-handle` | 0.25rem (4 px) | Handle between the list and the side pane. |
| `--width-pane` | 440 px default, 320 px minimum, 720 px maximum | Side detail pane. At most 60% of the main area, so the list keeps room for its title column. |
| `--height-pane` | 280 px default, 200 px minimum, 560 px maximum | Bottom detail pane. At most 70% of the main area, so the list keeps a few rows. |
| `--width-comment-column` | 11rem (176 px) | Comment column beside the spec. |
| `--width-reading-column` | 46rem (736 px) | Maximum width of the spec text. |
| `--width-settings-column` | 42rem (672 px) | Settings page content. |
| `--width-hover-zone` | 0.5rem (8 px) | Left-edge strip that reveals the closed sidebar. |

The sidebar width and the list and pane split are defined once, as these tokens and the pane width state.
Every region reads them. No region computes its own copy.

### Regions

- **Sidebar.** `--width-sidebar` wide, `--color-mantle` fill: a title row of `--height-header-bar`, the
  navigation, then Settings at the bottom.
- **Header.** Spans the main area (everything right of the sidebar): a title row of `--height-header-bar`,
  then for run views a chips row of `--height-chip-row`. `--color-background` fill.
- **Main area.** The list and the detail pane for run views, or a settings page. Regions scroll inside
  themselves. The page never scrolls.
- **Footer.** `--height-footer` high, `--color-mantle` fill, `--text-sm` in `--color-subtext`.

### Header

The title row is one line. Its content is the breadcrumb (when there is one), then the title, on one text
baseline. The breadcrumb is `--text-sm` in `--color-subtext`, separated by `/`. The title is `--text-md`,
weight 500, truncating. A breadcrumb exists in settings ("Settings / Projects") and for a run opened full
page ("Runs / title"). A top-level view has a title and no breadcrumb. The right end of the row holds
page controls: for run views, the view settings button (icon button, SlidersHorizontal, 14 px).

The chips row holds the view chips (see Collection). Horizontal padding is 12 px.

### Alignment

Region edges and text baselines line up across the shell. The rules hold with the sidebar open or closed,
in every theme, mode, and density, and in settings.

- The header title row and the sidebar title row share top and bottom edges. Their text uses the same size,
  weight, and line height, so the baselines match.
- The To do slot and the view chips row share top and bottom edges. The To do row and the chips are
  vertically centered in that shared height.
- The table column header row and the pane navigation row start at the header's bottom edge and share one
  height. Both use `--text-xs`, so their baselines match.
- The sidebar's bottom edge meets the footer's top edge, and the sidebar divider stops there.
- The sidebar zone's right edge equals the sidebar's right edge. The list zone's right edge equals the
  list's right edge, and the detail pane zone's left edge equals the detail pane's left edge, including
  while the pane resizes.
- Footer content is centered within its zone. Text in all five zones shares one baseline.
- The sidebar toggle sits at the left end of the left control zone and the pane toggle at the right end of
  the right control zone. Neither moves when the sidebar or the pane opens, closes, or resizes.
- The decision button's right edge is inset from the pane's right edge by the pane's horizontal padding, and
  it is vertically centered in the navigation row.

### Sidebar states

**Open.** The sidebar column is in the layout at `--width-sidebar`. The footer runs under it, and its top
border is continuous across the full width. The sidebar divider ends at the footer top.

**Closed.** The sidebar column has zero width. The header and the main area start at the viewport's left
edge. The sidebar zone has zero width, and the left control zone keeps the toggle. Closing and opening
animate the layout over `--duration-layout`.

**Hover (closed only).** The pointer entering the left-edge strip (`--width-hover-zone` wide, from the
top of the viewport to the footer top) shows the sidebar as an overlay. The overlay:

- is `--width-sidebar` wide, runs the full viewport height, and sits above the header and the footer;
- takes the pointer. Anything under it, including the header, the list, and the footer, does not receive
  hover or clicks while it shows;
- draws its own `--color-border` right divider over the full height, and uses `--shadow-popover`;
- closes when the pointer leaves it and focus is not inside it, and on `Escape`;
- does not move the main area. The layout under it stays as closed.

The hover strip ends at the footer top so the left control zone stays reachable. `[` toggles the sidebar
open and closed, and `]` shows and hides the detail pane.

### Sidebar content

Rows are `--height-control-base` high, `--radius-sm`, `--text-sm`, with a 14 px icon and an 8 px gap.
Nesting indents 14 px per level. A row with children has a 20 px chevron cell (12 px chevron) at its left;
a row without one keeps the cell empty so labels align.

| Part | Rule |
| --- | --- |
| Title row | "Autocatalyst" in `--text-md`, weight 500, 12 px left padding. |
| To do | First item, always shown. A 32 px slot with a 28 px row inside. Count at the right in `--text-xs`. Previous and next buttons (ChevronUp, ChevronDown, 13 px, 20 x 20 px) at the right edge. |
| Pinned | Heading, then pinned views with counts. Each expands to its first five runs, indented 14 px, with a status dot in front. The section is absent when nothing is pinned. An expanded view with no runs shows "No runs" in `--text-xs`. |
| Runs | Row with a plus button (Plus, 14 px, 20 x 20 px, top 4 px, right 4 px) that starts a run. Expanding lists every view with a pin toggle (Pin or PinOff, 12 px). A pinned toggle is `--color-primary`. |
| Projects | Row, then each project at depth 1, expandable to its runs at depth 2. |
| Settings | Last row, in its own block with a 1 px `--color-border` line above and 6 px padding. |

Headings are 24 px high, `--text-xs`, uppercase, `tracking-wide`, `--color-subtext`, with 12 px space above.
Sidebar sections have no dividers between them. Headings and space separate them.

Row states: rest is `--color-subtext` text. Hover adds `--color-hover` fill and `--color-text` text. The
active row has `--color-surface` fill and `--color-text` text and `aria-current="page"`. Counts and action
buttons never overlap the label: a row with an action reserves its width for the count.

## Dividers

Add a divider only where it separates regions. These are all of them.

| Divider | Spec |
| --- | --- |
| Sidebar right edge | `--color-border`. Runs from the top to the footer top when open, and the full height on the hover overlay. |
| Footer top | 1 px `--color-border`, full width. |
| Header bottom | 1 px `--color-border-subtle`. |
| List and pane | The 4 px resize handle, `--color-border-subtle`. `--color-primary` on hover, focus, and drag. |
| Column header bottom | 1 px `--color-border`. |
| Pane navigation row bottom | 1 px `--color-border`. |
| Tab strip bottom | 1 px `--color-border-subtle`. |
| Table row | 1 px `--color-border-faint` between rows. |
| Settings block in the sidebar | 1 px `--color-border` above Settings. |
| Setting row | 1 px `--color-border` between rows, none after the last. |

There is no divider between footer zones, between sidebar sections, between the header title row and the
chips row, or between the title and the tabs in the pane header. The gap between the list text and the
detail text in the footer separates those zones. A new divider needs an entry in this table.

## Collection

### View chips

The chips row shows the views of the current selection. Chips are `--height-control-sm` high, `--radius-full`,
12 px of horizontal padding at 8 px, `--text-xs`, weight 500, max width 12rem with truncation, 4 px apart.

| State | Style |
| --- | --- |
| Active | `--color-primary` fill, `--color-on-primary` text, `aria-current="true"`. |
| Inactive | `--color-border` outline, `--color-surface` fill, `--color-text` text. |
| Inactive hover | `--color-surface-1` fill. |
| Focus | 2 px `--color-focus` ring. |

A trailing plus chip (`aria-label` "Create named view") has the inactive style. The strip scrolls
horizontally and does not wrap.

### Table

The table is the default layout.

- The column header row is sticky at the top, `--height-pane-bar` high, `--color-background` fill, `--text-xs`,
  weight 500, `--color-subtext`, 12 px padding, with a 1 px `--color-border` line below. The sorted column
  shows an arrow (11 px, `--color-text`).
- A row is `--height-row-compact` or `--height-row-regular` high, with a 1 px `--color-border-faint` line below
  and 12 px horizontal padding. The title cell holds a status dot (8 px), the title in `--text-md`
  truncating, and the issue number in `--color-subtext` that never truncates. The title cell is at most
  18rem wide. Other cells are `--text-base` in `--color-subtext`.
- Time columns (started, duration, updated) use `tabular-nums` and show one unit ("3h").
- The project column is off by default. It shows only when the view turns it on.
- Hover is `--color-hover-row`. The selected row is `--color-surface`, has `aria-selected="true"`, and
  is the only row with that state. Rows are focusable (`tabindex="0"`), and `Enter` selects.
- A row action button (the "..." menu) is hidden until the row is hovered or has focus inside. It sits in a
  32 px trailing cell.
- The table scrolls in both directions inside its region, with a 640 px minimum width.

### Group headers

A group header spans the row width, is 28 px high, with a 12 px left padding, a chevron (12 px), the group
label (`--text-xs`, weight 500, `--color-subtext`), and the count in `tabular-nums`. The fill is
`--color-mantle`. A header sticks under the column header while its group scrolls. Clicking the header or
pressing `Enter` on it collapses the group (`aria-expanded`). A collapsed group keeps its header. A view
can hide empty groups.

### Other layouts and view settings

The list and board layouts use the same selection, hover, and status dot rules as the table. The view
settings button opens a popover 20rem wide that uses `--shadow-popover`. Its top sheet lists Layout, Properties,
Sort, Group, and Filter with the current value and a chevron. A sub-panel replaces the sheet and has a back
button, a title, and a close button. `Escape` closes it and returns focus to the button.

## Detail pane

The pane is `--color-background`, runs the full height of the main area below the header, and has three
preview modes: side (default), bottom, and full page. `aria-label` is "Run detail".

### Navigation row

One row, `--height-pane-bar` high, 12 px horizontal padding, 8 px gap, 1 px `--color-border` below:

1. In full page only: a "Back to list" text button (Esc).
2. Previous run and next run (ArrowUp, ArrowDown, 12 px, `--height-control-sm` high, 6 px padding, disabled
   at the ends).
3. The position, "m of n", in `--text-xs`, `tabular-nums`, `--color-subtext`.
4. A flexible gap.
5. Full screen (Maximize2, 13 px), only on the Spec and Acceptance tabs when the document is ready.
6. The decision button (see Gate decision), only while the run waits at a gate.

### Header and tabs

The pane body has 16 px padding and scrolls under the navigation row.

- Title: `--text-lg`, weight 500, 1.375 line height, left-aligned. Clicking it, or the Rename action, turns
  it into an input with a `--color-primary` border. `Enter` saves and `Escape` cancels. A pencil
  (12 px) shows on hover.
- Meta line, 8 px below: `--text-sm` in `--color-subtext`, 12 px gaps. It holds the issue number, the
  work kind chip, and the status word. The work kind chip has a 1 px `--color-border` outline, 6 px
  padding, `--text-xs`, `--color-text`, `--radius-sm`. The pane header shows no project name.
- Tabs, 12 px below the meta line: Radix Tabs, in this order: Summary, Spec, Acceptance, Activity. 16 px
  between tabs, 1 px `--color-border-subtle` line below the strip.
- Tab label: `--text-sm`. Selected is `--color-text` with a 2 px `--color-primary` underline. Others are
  `--color-subtext`, and `--color-text` on hover. Tab labels carry no counts.
- Every tab is present and enabled on every run. The selected tab stays as the operator moves between
  runs. A run without that tab shows Summary and keeps the stored choice.
- The tab body starts 16 px below the strip.

### Resizing

The handle between the list and a side pane is 4 px wide with `role="separator"` and
`aria-orientation="vertical"`. A bottom pane has a 4 px high handle with `aria-orientation="horizontal"`.
Arrow keys on a focused handle resize by 16 px, and dragging resizes continuously. The detail pane zone
follows every change.

### Full-screen overlay

The spec and the testing guide can fill the screen. The overlay is `position: fixed` over the viewport at
above the shell with `--color-background` fill and `role="dialog"`. It covers the shell, including the footer. Its
top row is `--height-pane-bar` high with the run title (`--text-sm`, weight 500, truncating), the position,
the decision button, and a close button (X, 14 px). The body has 24 px padding and a centered column of at
most 64rem. `Escape` closes it, after any confirm popover on top.

### Summary and Activity

- The progress bar has one segment per workflow stage, taken from data. A segment is 6 px high, `--radius-xs`,
  4 px apart: done is `--color-subtext`, current is `--color-text`, upcoming is `--color-surface-1`. Labels
  are `--text-xs` (weight 500 for current, `--color-subtext` for upcoming), with a check (11 px) on done and
  a lock (10 px) on a current segment with a gate. From 6 segments, only the current segment shows its label
  and the others shrink to 28 px and show their number, with the label in a tooltip. The bar never uses the
  primary fill, because the status chip is the attention signal.
- The facts block is a two-column list (16 px column gap, 8 px row gap) in a 1 px `--color-border-subtle`
  outline, `--radius-sm`, 12 px padding: labels in `--text-xs` and `--color-subtext`, values in `--text-sm`.
  Blocks on Summary are 16 px apart.
- Activity rows are 28 px high: a 14 px marker, the step name in `--font-mono` at `--text-xs`, a duration at
  the right in `tabular-nums`, and a chevron when the step has sessions. The current step has
  `--color-surface` fill and `aria-current="step"`. A session block is a 1 px `--color-border-subtle`
  outline, `--radius-sm`, 8 px padding, `--text-xs`. Failure reasons are `--color-red`.

## Spec reading column

The Spec tab shows the document and a comment column side by side with a 12 px gap. In the 440 px pane
the column is `--width-comment-column`. In the full-screen overlay the document column is at most
`--width-reading-column` and the comment column keeps its width.

### Document

The document is `--text-base` at 1.6 line height in `--color-text`. Selecting text is the only way to start
a comment. There is no general comment box.

- `h1`: `--text-xl`, weight 600, 1.3 line height, 12 px below. `h2`: `--text-lg`, weight 600, 20 px above and
  6 px below. `h3`: `--text-md`, weight 600, 16 px above and 5 px below. Paragraphs and lists: 6 px above and
  below. Lists indent 20 px.
- Tables: full width, `--text-sm`, 1 px `--color-border` cell borders, 4 px by 8 px cell padding, a
  `--color-mantle` header fill with weight 600.
- Inline code: `--font-mono`, `--text-sm`. Code blocks: shiki, `--font-mono`, `--text-sm`, 1.5 line height,
  1 px `--color-border` outline, `--radius-sm`, 10 px by 12 px padding, horizontal scroll. Diagram blocks:
  `--color-mantle` fill, 1 px `--color-border` outline, `--radius-sm`, 8 px padding, horizontal scroll.

### Comment markers

A marker is a highlight on the anchored text. It has `--radius-xs` and a `--duration-enter` background
transition. It is clickable and selects its comment.

| State | Style |
| --- | --- |
| Open | `--color-comment-open-bg` fill and a 2 px solid `--color-comment-open-line` underline. |
| Resolved | `--color-comment-resolved-bg` fill and no underline. |
| Selected | `--color-comment-selected-bg` fill and a 2 px solid `--color-primary` underline. |
| Jump target | `--color-comment-flash-bg` fading out once, over `--duration-layout` or longer, when a comment is reached with the previous and next buttons. |

Open and resolved differ by the underline as well as the color. The underline is the non-color signal. A
selected marker replaces the open or resolved style until another comment is selected.

### Comment cards

Cards stand in the comment column, each at the top of its anchor and pushed down to keep an 8 px gap. A card
is `--color-mantle` fill, 1 px `--color-border-subtle` outline, `--radius-sm`, 8 px padding, `--text-sm`.
Resolved cards are dimmed. The selected card has a `--color-primary` outline and uses `--shadow-popover`.

A card holds a meta line (author in weight 500, age, and the state chip at the right, all `--text-xs`), the
quoted text (2 px left border, 8 px left padding, `--text-xs`, italic, `--color-subtext`), the body,
replies (12 px indent, 1 px left border), and a reply input (24 px high, `--text-xs`) with a Resolve button
(Reopen on a resolved card). The state chip is `--text-xs`, 1 px outline, 4 px padding, `--radius-sm`: open
uses `--color-primary` for outline and text, resolved uses `--color-green`.

The composer appears at the selection: a quote line, a three-row textarea, a primary Comment button
(disabled while empty), and Cancel. A `--color-primary` outline and `--shadow-popover` mark it.
`Ctrl+Enter` or `Cmd+Enter` submits, and `Escape` cancels.

The detail pane zone shows "N open, M resolved" in `--text-xs` and the previous and next comment buttons
(ChevronLeft, ChevronRight, 12 px, 20 x 24 px).

## Gate decision

The decision is one button at a time, at the far right of the pane navigation row and of the overlay top
row. A run not waiting at a gate shows no button and an empty slot. A run waiting at the spec or
implementation gate shows "Approve" when no comment is open, and "Request changes (N)" when N comments are
open. Resolved comments do not count. A pull request gate has no button.

Both labels share one style: `--height-control-sm` high, 10 px horizontal padding, `--radius-sm`, `--text-xs`,
weight 500, `--color-primary` fill, `--color-on-primary` text. Hover and pressed dim the fill a step each. Focus shows the 2 px `--color-focus` ring with an offset. N uses `tabular-nums`. The label changes
in place when the count crosses zero.

Activating the button opens a confirm popover under it. `Enter` confirms and `Escape` cancels. The popover
is keyed to the action, so it resets when the label changes. Destructive run actions (cancel) use an alert
dialog whose confirm button is `--color-red` fill with `--color-on-destructive` text.

## Acceptance tab

- Instructions are a 1 px `--color-border` outline block, `--radius-sm`, 12 px padding, with a decimal list at
  `--text-sm`. A command sits in a copy block: `--color-mantle` fill, 1 px `--color-border-subtle` outline,
  `--font-mono` at `--text-xs`, and a copy button (Copy, 12 px) that shows "Copied" in `--color-green` for
  1.2 s.
- Each test item has a result group of `aria-pressed` buttons (Pass, Fail, Not tried) and an optional note
  field that works with any result. Buttons are `--text-xs`, 8 px by 2 px padding, `--radius-sm`, 1 px
  outline. Unpressed is `--color-border` with `--color-subtext` text. Pressed Pass is a `--color-green`
  outline with a `--color-sentiment-good-bg` fill. Pressed Fail is a `--color-red` outline with a
  `--color-sentiment-bad-bg` fill. Pressed
  Not tried is a `--color-border` outline with `--color-surface` fill.
- General feedback is a text area below the items. It is the one place feedback is not anchored.
- The detail pane zone shows the tally ("5 passed, 2 failed, 1 note, 2 not tried") and previous and next
  item buttons, in the comment count style.

## Status and waiting indicators

**Status dot.** An 8 px circle (`--radius-full`) with a tooltip naming the status: in progress is
`--color-primary`, done is `--color-green`, failed is `--color-red`, canceled is `--color-overlay`.

**Waiting chip.** `--text-xs`, 6 px padding, `--radius-sm`, no wrap.

- "Waiting on you": `--color-primary` fill, `--color-on-primary` text.
- "Working" (an agent or the system holds the run): 1 px `--color-border` outline, `--color-subtext` text.
  "Paused" uses the same style.
- A run that ended shows a dash in `--color-subtext`.

**Status word.** In the pane meta line: Done in `--color-green`, Failed in `--color-red`, Canceled in
`--color-subtext`, and the waiting chip for a run in progress.

"Waiting on you" is the only primary-filled signal in the run list and the pane header. No tab, count, or
row carries a second attention signal. Counts in the sidebar are plain `--color-subtext` text.

**Step markers** (Activity), 14 px: done is CheckCircle2 in `--color-green`, failed is XCircle in
`--color-red`, canceled is XCircle in `--color-overlay`, waiting on you is Hand in `--color-primary`, running
is a spinning Loader2 in `--color-primary`, skipped is MinusCircle in `--color-overlay`, and not started or
not reached is Circle in `--color-overlay`. Skipped and not-reached rows are dimmed.

**Connection.** When the connection is lost or degraded, the list zone shows an 8 px `--color-red`
dot and "Connection lost" in `--color-red` before the counts. A healthy connection shows nothing.

## Empty states

An empty state is centered in its region with 16 px padding, a title in `--text-md`, one line of
explanation in `--text-sm` and `--color-subtext`, and at most one primary button. It says why the region is
empty and what happens next. It has no illustration.

| Place | Content |
| --- | --- |
| No projects (run list and Projects page) | "Add a project to get started" and an "Add project" button. With no connection set, the button opens Connection settings first. |
| No runs | "No runs yet", "Start a run from a tracked issue and it will show up here.", and a "Start a run" button. |
| Tab with nothing to show | The reason ("Bugs skip the spec.", "The spec is being drafted. You will be asked to review it here.") and what comes next. No button. |
| Pinned view with no runs | "No runs" in `--text-xs` at 40 px left padding. |
| Projects page, list empty | The "Add a project" text and button in a 1 px dashed `--color-border` outline, `--radius-sm`, 40 px vertical padding. |

The detail pane has no empty state while the list has a run. When the selected run leaves the view, the
next run is selected.

## Settings pages

Settings replaces the sidebar with a settings sidebar and the main area with one page. The header shows
"Settings" as the breadcrumb and the page name as the title. The footer is unchanged.

- Settings sidebar: the title row (`--height-header-bar`) holds "Settings" and a close button (X, 14 px,
  24 x 24 px, tooltip "Close settings (Esc)"). Below it, a category row per page: General, Appearance,
  Connection, Projects, with the sidebar row rules and a 14 px icon. The selected category is always
  one of them.
- A page scrolls in the main area with 24 px padding and a content column of at most
  `--width-settings-column`, left-aligned.
- The page header is a title (`--text-lg`, weight 600) over a description (`--text-sm`, `--color-subtext`),
  with 8 px below it.

### Row pages (General and Appearance)

A setting row has the label (`--text-sm`, `--color-text`) and an optional description (`--text-xs`,
`--color-subtext`, 2 px above) at the left, the control at the right, 12 px of vertical padding, 16 px
between the two sides, and a 1 px `--color-border` line below (none after the last row). These pages apply
every change immediately and have no Save button.

- **General.** UI font (Inter Variable, SF Pro, Helvetica Neue, Arial) and code font (Fira Code, JetBrains
  Mono, Cascadia Code, Menlo). The choices set `--font-sans` and `--font-mono`.
- **Appearance.** Theme mode (System, Light, Dark), light theme, dark theme, then a section "Accent colors"
  (`--text-sm`, weight 600) with the primary and secondary accent, then a Preview. The page description
  names the theme currently in effect in `--font-mono`.
- **Preview.** A 1 px `--color-border` outline, `--color-surface` fill, `--radius-sm`, 12 px padding. It shows
  a primary link, a primary button, a secondary-accent chip, and good, ok, and bad status chips, so the
  operator can judge a theme and accent before leaving the page. The preview uses the same tokens as the
  rest of the client and never its own colors.

### Form pages (Connection and Projects)

A form has 16 px between fields, a field column of at most `--width-settings-column`, and an action row:
the test button at the left, a flexible gap, a "Saved" confirmation (`--text-sm`, `--color-subtext`), Cancel
(secondary), and Save (primary). Save is disabled until the form is valid. Cancel restores the saved values.

- A field is a label above the control (`--text-sm`), the control, and an optional hint (`--text-xs`,
  `--color-subtext`) below. An input is 28 px high, `--radius-sm`, 1 px `--color-border` outline,
  `--color-background` fill, 8 px padding, `--text-sm`. Placeholder text is `--color-subtext`. Focus is the
  2 px `--color-focus` ring.
- **Connection** has the base URL and the bearer token. **Projects** lists projects (name, repository,
  tracker, last test) with an Edit button each and an "Add project" button. Add and Edit show one
  focused form that replaces the list, and Save or Cancel returns to it. The form has name, repository
  (`owner/name`), tracker, and credential.
- **Test button.** "Test connection" or "Test credentials", secondary style, disabled while a test runs. The
  result sits above the action row in a `role="status"` region, with an 8 px dot and one of four states:
  Not tested (`--color-overlay` dot, `--color-subtext` text), Testing (same), Connected (`--color-green` dot
  and text, with the success message), or Failed (`--color-red` dot and error text, then a suggested fix in
  `--color-subtext` one line below).

### Write-only secret field

A secret (bearer token, project credential) is a password input with `autocomplete="off"`. The control
never receives a stored value, so it is empty every time the form opens.

- There is no mask, no "stored" badge, no reveal button, and no clear or delete control.
- With no secret stored, the label reads "Bearer token" (or "Credential") and the field is required.
- With a secret stored, the label reads "Bearer token (leave blank to keep existing)". The same text
  pattern applies to "Credential". An empty field keeps the stored secret. A new value replaces it.
- After a save, the field empties. A failed test of a typed value leaves the value in the field and the
  stored secret unchanged.
- The secret is never placed in a URL, a log line, a toast, or an accessible name.

## Overlays and menus

Radix primitives supply behavior and focus handling. Tokens supply the styling.

- Menus, context menus, and popovers: `--color-mantle` fill, 1 px `--color-border` outline, `--radius-sm`,
  `--shadow-popover`, 4 px padding. Items are 28 px high, `--text-sm`, with the key right-aligned in `--text-xs`. A
  highlighted item has `--color-surface` fill.
- Dialogs: `--color-background` fill, 1 px `--color-border` outline, `--radius-sm`, `--shadow-dialog`, 16 px
  padding, and a `--color-crust` backing. A title (`--text-md`, weight 500), one short description
  (`--text-sm`, `--color-subtext`), the body, then a right-aligned action row 16 px below with 8 px between
  buttons and Cancel left of the confirm action. Start a run is a dialog.
- Tooltips are required on every icon-only button: `--text-xs`, `--color-mantle` fill, 1 px outline.
- Run actions live in a "..." button shown on row hover, a right-click menu, and an overflow button in the
  pane header. All read the action registry.

## Buttons

Primary: `--color-primary` fill, `--color-on-primary` text, `--text-sm`, weight 500, 12 px by 4 px padding,
`--radius-sm`, dimmed on hover and more so when disabled. Secondary: 1 px `--color-border` outline,
`--color-text` text, `--color-surface` hover fill. Destructive: `--color-red` fill with
`--color-on-destructive` text. Icon: `--height-control-sm` high, `--color-subtext` icon, `--color-surface`
hover fill. A disabled icon button uses `aria-disabled` so it keeps its tooltip.

## Focus and keyboard

- Every interactive element shows a 2 px `--color-focus` ring on `:focus-visible`, and none shows one on mouse
  focus. Inputs show it on focus.
- Tab order follows the visual order: sidebar, header, list, pane, footer. The list is one tab stop. Arrow
  keys and `j` and `k` move the selection inside it.
- Every action is registered once with a name, a key, and a rule for when it applies. Menus, tooltips, and
  the shortcuts overlay read the registry.
- A key shows beside its action: in a tooltip as "Label (key)", and at the right of a menu item as a key
  cap. A key cap is `--font-mono`, `--text-xs`, `--color-subtext`, `--color-surface` fill, 1 px
  `--color-border` outline, `--radius-sm`, 4 px horizontal padding. macOS shows glyphs (command, option,
  control, shift) and other platforms spell them ("Ctrl+Shift+K"). A sequence shows a cap per step with
  "then" between them and times out after 1500 ms.
- Single-key shortcuts do not fire in an input, textarea, select, or editable element, while a menu or
  dialog is open, or with a modifier held. The settings toggle (`Cmd+,` or `Ctrl+,`) works everywhere.
- Current bindings: `j` and `k` next and previous run, `r` recover, `x` cancel, `e` archive, `s` set step, `m`
  rename, `f` full screen, `n` start a run, `[` toggles the sidebar and `]` toggles the detail pane (comment navigation uses the registry's own keys and the footer buttons), `?` the
  shortcuts overlay, and `Escape` to close the top layer (a confirm popover, then the overlay, then full
  page, then settings).
- A control shown on row hover also shows when focus is inside the row.

## Playwright geometry assertions

Playwright checks these with `getBoundingClientRect` on regions located by role and accessible name: the
sidebar (`navigation`), the header (`banner`), the footer (`contentinfo`), the five footer zones (named by
zone), the detail pane (`complementary` named "Run detail"), the resize handle (`separator`), the tablist
(named "Run detail tabs"), and the chips (named "Collection views"). Edges match within 0.5 px and text
baselines within 1 px. Each assertion runs with the sidebar open and closed, in light and dark themes, in
compact and regular density, and on a run view and a settings page, unless it names a state. Where a size
has a token, the test reads the token and does not hard-code the number.

Alignment:

- The header title row's top and bottom edges equal the sidebar title row's. Their title text baselines
  match (sidebar open).
- The chips row's top and bottom edges equal the To do slot's, and the active chip's vertical center equals
  the To do row's vertical center (run views, sidebar open).
- The table column header row's top edge equals the pane navigation row's top edge, and both equal the
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

Sidebar behavior and dividers:

- With the sidebar closed, moving the pointer into the left-edge strip shows the overlay. Its top edge equals
  the viewport's top edge, its bottom edge equals the viewport's bottom edge, and its width equals
  `--width-sidebar`. It closes on `Escape` and when the pointer leaves it.
- With the overlay showing, `elementFromPoint` at a point in the header and a point in the footer, both
  within the overlay's horizontal range, returns an element inside the overlay. The header, list, and pane
  keep the positions they had with the sidebar closed.
- `[` toggles the sidebar and `]` toggles the detail pane, and the geometry rules above hold after each.
- The resize handle's width equals `--width-resize-handle`, and the pane's left edge equals the handle's
  right edge.
- The elements with a visible border match the divider table. Nothing between the header title row and the
  chips row has a border.

Pane, rows, and documents:

- The decision button's right edge is inset from the pane's right edge by the pane's horizontal padding, and
  its vertical center equals the navigation row's.
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
