---
created: 2026-10-30
last_updated: 2026-10-30
status: draft
roadmap: web-client
doc_id: 6aa31c18-fba8-428a-8778-4c63054ef70c
---

# Collection

The collection is how an operator sees and navigates runs. It treats the runs as one array of items, each
with properties, and everything about how they appear is the configuration of a named view. A view can
filter, sort, and group the runs, choose which properties show, and set the layout, so an operator can
shape the list into exactly the runs they want to see. It does not own what the detail pane shows for a run
(`run-detail`), the shell around it (`ux`), or run state (`run`).

## An array of runs

Every run is an item in a single array. Each item has properties, such as the issue's number and title, the
work kind, the status, what the run is waiting on, the project, and the age. There are no separate lists
for running, finished, or failed runs. Everything the operator sees is a view of the one array, so a change
to a run shows up in every view that includes it.

## Named views

A view is a named configuration of how the array is presented. Views appear as chips above the list, and the
operator switches between them. A set of default views covers common questions, such as all runs, runs in
progress, and failed runs. Operators add their own, and can pin a view so it appears in the sidebar with a
count. Changes to a view apply immediately and are saved with it.

Some views use a rule that another concept owns. To do, for example, shows the runs that need the operator,
as `run` defines them.

A view controls:

- **Layout.** How items are drawn. The table is the default. A view also sets where the detail pane sits
  (beside the list, below it, or as a full page) and the row density (compact or regular).
- **Properties.** Which properties show, in what order, and on which side of the row. The title property
  always shows.
- **Filter.** One or more conditions on a property. Each has an operator that fits the property's type, such
  as "is" for a status, and a value when the operator needs one. Conditions combine with AND. A condition
  without a value does not apply.
- **Sort.** One or more properties, in order, each ascending or descending.
- **Group.** One property, or none. Each group has a header with its count, and the operator can collapse
  it. A property with many values, such as age, groups into buckets, such as today, this week, and older. A
  view can hide empty groups.

The view applies these in a fixed order: filter, then sort, then group, then draw each row. The order the
operator sees is the order navigation follows.

## Selection

When the list has rows, one run is always selected, and the detail pane shows it. If the selected run leaves
the view, for example because a filter excludes it, the next run in the view is selected. The selected tab
in the detail pane stays the same as the operator moves through the list, so reviewing several runs at the
same gate takes no extra clicks. A run that lacks that tab shows its summary instead.

## Relationships

- Reads `api` for the run list and run actions.
- `run` defines the state and waiting class that views filter and group on.
- `hitl` defines the gates and pauses a run waits at.
- `run-detail` fills the detail pane.
- `ux` defines the shell, the sidebar that shows pinned views and To do, and the action registry that
  supplies the actions on a row.

## Constraints and decisions

- Runs are one array, and every other grouping is a view over it.
- A view changes how runs are presented and never changes the runs.
- The selected tab persists across runs, so a reviewer can work through a queue at one gate.

## Open edges

- **Other layouts**, such as a board, a gallery, a timeline, or a calendar, are further ways to draw the same
  array, taken up when an operator needs one.
- **Richer filters**, such as OR groups, are taken up when views need them.
- **A change feed** — so the list and counts update without asking the control plane again — replaces
  polling, taken up when the API offers one.
- **Server-side filtering and paging** are taken up when the number of runs outgrows loading the whole
  array.
