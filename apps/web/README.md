# @autocatalyst/web

The Autocatalyst web client: a React 19 + Vite + Tailwind 4 browser app served by
the control plane. The foundation (issue #131) shipped the runtime — routing, design
tokens, theme preferences, safe token storage, typed SDK access, the first UI
wrappers, and lazy syntax highlighting. Issue #132 adds the operator **shell**
(sidebar, header, main area, footer with five zones and a health indicator), the
**settings frame**, and the **Connection** page where an operator enters the control
plane bearer token. The run list and detail pane are still **out of scope** here —
they arrive in #134.

## Targets

Run these from the repo root with Nx.

| Target | Command | What it does |
| --- | --- | --- |
| `build` | `pnpm nx build web` | Vite production build to `apps/web/dist` with hashed asset names and a manifest. |
| `dev` | `pnpm nx dev web` | Vite dev server (no API proxy). |
| `test` | `pnpm nx test web` | `vitest run` from `apps/web` (jsdom), including the real-build output checks. |
| `lint` | `pnpm nx lint web` | ESLint over `.ts`/`.tsx`/`project.json`/`package.json`, including module boundaries and the Base UI import restriction. |
| `e2e` | `pnpm nx e2e web` | Builds the app + control plane, then runs Playwright against the **real built app** served by a fake-mode control plane. |

`build`, `lint`, and `test` are part of `pnpm nx run-many -t build lint test` and
`pnpm validate`. `e2e` is **not** in CI or `validate` — it needs a one-time browser
install (see below).

## Running against fake mode

The control plane can serve this app's build from its own origin. Build the client,
then start the control plane in fake mode pointed at `apps/web/dist`:

```bash
pnpm nx build web
AUTOCATALYST_CLIENT_DIR=apps/web/dist pnpm nx serve-fake control-plane
```

Open the printed origin (for example `http://127.0.0.1:4100/`). `/` redirects to
`/runs`; refreshing `/runs` or visiting an unknown path returns `index.html` and the
router renders the right page (see #129 for the control plane's static serving and
`index.html` fallback). No model call is made in fake mode.

The Playwright e2e target automates this: each spec starts its own fake-mode control
plane serving `apps/web/dist` (the `web:build` dependency produces it) and drives the
real foundation page. See `e2e/fixtures/fake-server.ts` (default `clientDir` is
`apps/web/dist`; pass `clientDir` to override).

### One-time browser install

Playwright keeps browsers outside `node_modules`; `pnpm install` does not download
them. Install Chromium once per machine (and after a Playwright version bump):

```bash
pnpm exec playwright install chromium
```

If Chromium is missing, the e2e preflight stops before any test runs with the exact
install command — a skipped test would read as a pass, so it fails loudly instead.

## Routing

The router is **`react-router-dom` using the declarative `BrowserRouter` / `Routes` /
`Route` / `Navigate` APIs** with base `/`. This gives normal browser history,
redirects, and not-found routing without pulling in a framework runtime or a data
router we do not yet need. A layout route renders the persistent shell
(`src/shell/shell-layout.tsx`) around the child routes. Routes: `/` → `/runs`,
`/runs` = the Runs destination (`src/routes/runs-page.tsx`), `/settings` →
`/settings/connection`, `/settings/connection` = the Connection page
(`src/settings/connection-page.tsx`), catch-all = the not-found page (outside the
shell). `app.tsx` exports `AppRoutes` separately so tests can mount it under a
`MemoryRouter`.

## Keyboard shortcuts

Every action is declared once in the **action registry** (`src/shell/action-registry.ts`);
tooltips, menus, and the shortcuts overlay read their key text from it. The pure
chord-matching and formatting helpers live in `src/shell/key-utils.ts`, and window dispatch
plus the one shared pending-sequence tracker live in `src/shell/use-action-keys.ts`
(`src/shell/shell-keys.ts` remains a thin legacy adapter over the same mechanics). An
action can declare **alternates** (several bindings, shown separated by "or") and a binding
can be a **sequence** of chords (shown separated by "then", e.g. `g then r`, firing within
`SEQUENCE_TIMEOUT_MS`). No shipped action uses a sequence yet. Matching is per-chord and
exact: letters are lowercase-authored and CapsLock-safe with Shift significant (`j` ≠
`Shift+J`), printable non-letters such as `?` ignore Shift, `mod` is Cmd/Ctrl by platform,
and a named `alt` matches the physical `event.code`. Registry validation rejects duplicate
bindings and sequence-prefix conflicts.

| Shortcut | Action |
| --- | --- |
| `[` | Toggle the sidebar open/closed. Does not fire while typing in a field, while a menu/dialog is open, with the platform modifier or Alt held, or with AltGr active. |
| `]` | Toggle the detail pane (on the runs route). |
| `Cmd+,` (macOS) / `Ctrl+,` | Open and close Settings. Works everywhere, including inside a form field. |
| `?` | Open the keyboard shortcuts overlay. |
| `j` / `↓`, `k` / `↑` | Select the next / previous run while focus is inside the run list. |
| `Escape` | Close the top layer: the hover sidebar first, then Settings. |

## Package aliases

`vite.config.ts` aliases both `@autocatalyst/sdk` and `@autocatalyst/api-contract` to
their **source** (`packages/*/src/index.ts`), not built output. The control plane
resolves the SDK through package output, but the browser build aliases to source so
the Node-import guard and bundle checks see everything that ships to the client. The
root `tsconfig.base.json` already maps both package paths, so no new path entries are
needed. Nx may still build source dependencies where target orchestration requires
it; browser code always resolves these two packages through the source aliases.

## Storage keys

Two separate browser `localStorage` keys, read and written inside `try`/`catch` so
blocked or invalid storage falls back to defaults without crashing:

- **`autocatalyst.preferences`** — operator theme preferences. Fields: `themeMode`
  (`system` | `light` | `dark`), `lightTheme`, `darkTheme`, `primaryAccent`,
  `secondaryAccent`, `bodyFont`, `monoFont`. Unknown ids fall back field-by-field
  while keeping the valid fields. Defaults: `system`, `catppuccin-latte`,
  `catppuccin-mocha`, `sapphire`, `teal`, and the design-system body/mono font stacks.
  There is no settings UI yet; change preferences by editing this key in browser
  storage until the appearance/settings screens exist.
- **`autocatalyst.bearerToken`** — the bearer token, kept **separate** from
  preferences because it is secret material, not a preference. `src/auth/token-store.ts`
  exposes write/clear and an internal read used only by the SDK client provider to
  build the client; there is **no** component-facing getter that returns the token for
  display. On blocked storage it falls back to an in-memory value for the session. The
  token never appears in URLs, logs, thrown messages, or the DOM. A future desktop
  wrapper will replace this key with keychain storage (see the proposed ADR-031 / UX
  patch under `context-agent/proposed-human-docs/`).

## SDK client provider

`src/client/client-provider.tsx` builds one `createControlPlaneClient` from
`window.location.origin` and the current token, and rebuilds it when the token
changes. Components get the client from `useControlPlaneClient()` (or the full
connection from `useControlPlaneConnection()`) and **never call `fetch` directly** for
control-plane routes, so authorization and error handling stay in one place. A `401`
from any call flips connection state to `unauthorized` without throwing to the route;
`getHealth()` sends no `Authorization` header, protected calls send
`Authorization: Bearer <token>`.

## UI wrapper convention

`src/ui/` holds the client-owned components and is the **only** place allowed to import
`@base-ui/react` — enforced by ESLint and the `import-conventions` test. Screens import
these components, never Base UI primitives directly. Every icon-only button carries a
`Tooltip`. Icons come only from `lucide-react`, imported by name. Each file's top comment
states whether it **wraps Base UI** or is **custom** (Base UI has no primitive for it).

- Base UI wrappers: `Button`, `Tooltip`, `Dialog`, `Tabs`, and the form building blocks
  `Input`, `Field`, and `WriteOnlySecretField`. `WriteOnlySecretField` receives only a
  `hasStoredValue` boolean (never a stored secret), is a password input with
  `autocomplete="off"`, and has no mask, reveal, stored badge, or clear/delete control.
- Custom components: `ResizeHandle` (pane separator), `Chip` (tone label), `EmptyState`,
  `DescriptionList`/`DescriptionItem`, and `Kbd`/`Shortcut`/`ShortcutList` (key caps).

The remaining Base UI wrappers — `Menu`, `Popover`, `Select`, `Switch` — should still be
added by the first screen that actually uses each one. No component should exist without a
screen exercising it, and **every `ui/` component must have a gallery entry** (see below).

## Component gallery

A development-only gallery lives at `/dev/components`. It renders every `ui/` component
across useful states, themes, and key-cap platforms in one place, with no bearer token,
no control-plane call, and no model call. To open it, start the dev server and visit the
route:

```bash
pnpm nx dev web
# then open http://localhost:<port>/dev/components (port is printed by the dev server)
```

The toolbar switches theme mode, the light theme, the dark theme, the primary and
secondary accent, the key-cap platform, and the sample surface (`background` or
`mantle`); those controls are local to the page and never write stored preferences. Each
sample well sits on a real app surface — `--color-background` by default, `--color-mantle`
via the Surface control — with a `--color-border` outline, so components are judged against
the same background the app uses rather than the grey `--color-surface`. `Field` and
`Input` show their error and loading states alongside the default and disabled ones.

The route is registered **only** when `import.meta.env.DEV` is true and its module is
lazily imported behind that guard, so production builds omit it entirely — a built app
serves the not-found page for `/dev/components` (proven by `e2e/served-page.spec.ts` and
the `dev/gallery-production-build.spec.ts` output assertion).

**Adding a `ui/` component requires a gallery entry.** Add it to
`src/dev/component-gallery-registry.ts` (id = the file basename) and render it in
`src/dev/components-gallery.tsx`; the completeness test fails, naming the file, until the
entry exists.

## Syntax highlighting (Shiki)

`src/highlight/highlight.ts` uses the **fine-grained `shiki/core` API**, not the
bundled `createHighlighter`. On first use it dynamically imports `shiki/core`,
`shiki/engine/javascript` (`createJavaScriptRegexEngine`), `shiki/langs/json.mjs`, and
the `shiki/themes/github-light.mjs` / `shiki/themes/github-dark.mjs` code themes, then
creates one highlighter and reuses it. Only JSON is loaded today; later callers may
extend it with their own explicit language imports. The code theme follows the
resolved app brightness. Because every Shiki import is dynamic, Shiki stays out of the
entry chunk. `highlight.ts` is a retained utility for later screens that render code;
#132 removed its only caller (the #131 foundation page), so no current route loads the
Shiki chunk.

> Note: these exact subpaths (`shiki/langs/json.mjs`, `shiki/themes/github-*.mjs`,
> `shiki/engine/javascript`) resolve in the installed Shiki 4.5.0 via its `./*` export,
> matching the documented fine-grained paths.

## Design tokens and palette provenance

`src/styles/index.css` declares the Tailwind 4 `@theme` structural tokens (type,
spacing, control heights, radii, elevation, shell dimensions, motion) and the default
color values; `src/styles/themes.css` (generated by `tools/gen-themes.mjs`) defines
the eight `data-theme` blocks and the per-accent `--color-on-primary` /
`--color-on-secondary` selectors. Every theme declares all fourteen `--accent-<id>`
variables (`rosewater`, `flamingo`, `pink`, `mauve`, `red`, `maroon`, `peach`,
`yellow`, `green`, `teal`, `sky`, `sapphire`, `blue`, `lavender`). `--primary-accent`
and `--secondary-accent` default to `sapphire` and `teal`. Outside `src/styles/`, web
source uses semantic tokens only — never a hex color, an `rgb()`/`rgba()` value, or a
raw `--ctp-*` name (enforced by `style-safety.spec.ts`).

Palette values are copied as literals from documented upstream sources — no palette
package dependency is added:

| Theme(s) | Upstream source |
| --- | --- |
| Catppuccin Latte / Frappé / Macchiato / Mocha | Catppuccin palette **v1.7.1** (`https://github.com/catppuccin/catppuccin`), raw names mapped `base→background`, `mantle→mantle`, `crust→crust`, `surface0/1/2→surface-0/1/2`, `overlay0/1/2→overlay-0/1/2`, `subtext0/1→subtext-0/1`, `text→text`, plus the 14 accents. |
| GitHub Light / Dark | GitHub Primer Primitives (`https://github.com/primer/primitives`). The spec names **v9.3.0**; the copied values are from the closest published release available at implementation time (**v9.1.2**) — recorded here as a provenance note. `canvas.*`/`neutral.*`/`border.*`/`fg.*` mapped to the semantic bases; the 14 accents come from the Primer `scale.*` ramps per the spec's accent table. |
| Solarized Light | Ethan Schoonover Solarized, canonical repo (`https://github.com/altercation/solarized`); `base3→background` … `base00→text`, with documented `color-mix`/precomputed mixes for `crust`/`surface-1`; accents mapped from `magenta`/`orange`/`violet`/`red`/`yellow`/`green`/`cyan`/`blue` per the spec table. |
| Dracula | Official Dracula spec (`https://github.com/dracula/dracula-theme`); `background→background`, `currentLine→surface-0`, `comment→surface-2`/`overlay-0`/`subtext-0`, `foreground→text`/`overlay-2`, with documented darker/foreground mixes; accents mapped per the spec table. |

### Contrast-driven adjustments

The contrast test (`contrast.spec.ts`) checks exact token pairs across every theme and
every primary accent with **no exemptions**: body text ≥ 4.5:1 on background and
mantle, secondary text ≥ 4.5:1 on background, `--color-on-primary` ≥ 4.5:1 on the
selected accent, `--color-on-destructive` ≥ 4.5:1 on red, focus ring ≥ 3:1, and the
component border ≥ 3:1. Where an upstream value failed a pair, the mapped semantic
token (or per-accent foreground) is nudged in `src/styles/` — never excused — and the
adjusted literal is commented next to its value. The generator header in `themes.css`
records the total number of contrast-driven adjustments. `--color-on-primary` /
`--color-on-secondary` are computed per theme+accent (black or white, whichever meets
contrast) rather than a single fixed literal.

## No per-app agent note file

This project deliberately has no per-app `AGENTS.md`/agent note file; the repo-level
`context-agent/wiki/code-map.md` records `apps/web`'s layout, targets, served build
output, and the `scope:web` boundary.
