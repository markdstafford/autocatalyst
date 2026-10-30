---
created: 2026-10-30
last_updated: 2026-10-30
status: proposed
decided_by: null
superseded_by: null
---

# ADR-032: Web client stack

## Status

Proposed for human review.

## Context

The client is a dense, keyboard-first operator console (`ux`). It renders a run list, a detail pane, a spec
with comments anchored to source ranges, and settings screens. It is tested with a scripted control plane
and a real browser. The choices below are hard to change once screens exist, so they are made once.

## Decision

**React 19 with Vite, Tailwind 4, headless Radix primitives behind the client's own thin components,
lucide-react icons, Shiki for code in specs, Vitest for unit tests, and Playwright for end-to-end and
layout tests.**

- **React 19 and Vite.** The widest ecosystem for accessible primitives, tables, virtualized lists, and
  Markdown rendering. It has the most reference code for agents to follow.
- **Tailwind 4.** Theme tokens are CSS custom properties, so the operator's light and dark theme slots
  and accents apply at run time. The design system (`context-agent/wiki/design-system.md`) names the
  tokens.
- **Headless primitives behind our own components.** Screens import the client's own `Dialog`, `Menu`,
  `Tabs`, and so on, never the primitive library directly. That lets the library change in one place.
  Radix is the first choice. Base UI is the likely alternative if Radix falls behind.
- **lucide-react.** One icon set, tree-shaken.
- **Shiki.** Highlighting quality matches the editor the operator knows. It runs in the browser here,
  because specs render client-side, so the client loads it on first use with the JavaScript regex engine
  and only the languages a spec uses.
- **Vitest and Playwright.** Playwright also checks layout geometry, which the design system states as
  rules.

## Consequences

**Pros:**
- Every choice is current and actively released.
- Swapping a primitive library or the code highlighter touches the client's components, not its screens.

**Cons:**
- Shiki is the largest dependency of its kind. Lazy loading keeps it out of the first screen.
- Headless primitives give no list or table keyboard model, so the run list's focus handling is ours.

## Alternatives considered

### Solid or Svelte instead of React

**Pros:** smaller bundles and fine-grained updates suit a dense list.
**Cons:** fewer accessible primitives and fewer examples for agents to follow.
**Why not chosen:** the ecosystem matters more than raw speed for a list of tens to hundreds of rows.

### React Aria Components or Base UI instead of Radix

**Pros:** React Aria has built-in table and list keyboard models. Base UI is the actively developed
successor from Radix's creators.
**Cons:** React Aria is a larger, more opinionated API. Base UI is newer, with fewer references.
**Why not chosen:** both are viable. The wrapper components keep the choice reversible.

### highlight.js or Prism instead of Shiki

**Pros:** much smaller.
**Cons:** coarser highlighting.
**Why not chosen:** lazy loading removes the size cost from the first screen.
