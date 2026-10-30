---
created: 2026-10-30
last_updated: 2026-10-30
status: draft
roadmap: web-client
doc_id: b372c44c-cfcb-448c-b530-5215ce40cd9a
---

# UX

Autocatalyst's web client is where an operator manages runs: finding a run that needs them, following it,
reviewing it at each gate, and acting on it. It is also the baseline for every other client. This concept
sets the general shape of that client: the principles it follows, how it fits with the control plane and
other devices, and the structure of the shell. The run list is in `collection`, what the detail pane shows
for a run is in `run-detail`, and the rules for how screens look are in the design system
(`context-agent/wiki/design-system.md`).

## Principles

- **Dense and keyboard-first.** The client is built for developers, so it favors dense layouts and keyboard
  shortcuts over spacious, mouse-first screens. Every action has a shortcut. Every action is registered
  once, with a name, a shortcut, and a rule for when it applies, and menus, shortcuts, and any command
  palette read that registry.
- **The operator manages the work, and the agents do it.** The operator delegates work to agents and gives
  feedback on the results. They do not work with an agent interactively, as in a chat. So the client mostly
  presents information (state, documents, progress) and asks for a decision at a gate.
- **Runs are a collection with named views.** Runs are one flat list that the operator groups, sorts, and
  filters into named views.
- **Feedback is comments on the result.** Feedback on a spec or a testing guide is captured as comments
  anchored in the document. The operator reacts to the agent's work and does not edit it.
- **A run is not tied to a device.** The control plane holds all run state, so an operator can start a run
  on one device and continue it on another.

## One web app for every device

The client only talks to the control plane. It holds no run or project state of its own, and the browser
keeps only the operator's preferences. This is what lets a run move between devices.

The web app is the baseline for the other clients. The desktop app wraps the same web app and adds device
features such as a keychain. A mobile mode shows a subset, because the full set of information does not fit
that form factor.

## The shell

The shell has four regions.

- **Sidebar.** Navigation: **To do** (runs that need the operator), **Pinned** (saved views), **Runs** (every
  view, and the control that starts a run), **Projects**, and **Settings**. It can close.
- **Header.** The title of the current view and, for runs, its view chips.
- **Main area.** A collection with its detail pane, or a settings page.
- **Footer.** At-a-glance information, such as the state of the list, and a few controls, such as those for
  the detail pane.

The main area for runs is a collection beside a detail pane. `collection` describes the list, its views, and
how a run starts. `run-detail` describes what the pane shows for a run. The pane is generic, so other kinds
of item can use it.

## Settings

Settings replaces the sidebar with a settings sidebar and shows one page per area. The areas cover the
connection to the control plane, projects and their credentials, appearance, and general preferences. A
page that needs a credential has a test button that shows whether the credential works. The client never
shows a secret back. To change one, the operator enters a new one.

## Relationships

- Reads `api` for every operation and for the event stream, and `run` for run state.
- `collection` and `run-detail` fill the main area.
- `settings` owns the records the settings pages edit. This concept owns the editing screens.
- `run` defines the phases and steps of a run, which `run-detail` shows.
- The design system sets tokens, dimensions, and component rules for every screen.

## Constraints and decisions

- The client starts a run only from a tracked issue. It does not collect a description, so writing a good
  issue (research, a clear description) stays separate from running one.
- One web app serves every device. One code base avoids keeping a web, a desktop, and a mobile client in
  step.

## Open edges

- **Issue creation** — turning a request into a well-formed issue — has its own screen, taken up when
  operators need to start from a request instead of an issue.
- **A command palette** reads the action registry, taken up when the number of actions outgrows menus and
  shortcuts.
- **The mobile subset** is undecided. It probably covers what needs the operator, such as the to do list and
  gate decisions.
- **Hosted operation** — pull request changes arriving by webhook, and each operator signing in — builds on
  the same API, taken up when the control plane is hosted.
