# Approval gate keys (`waitForApprovalBefore`)

This is the canonical table of valid `waitForApprovalBefore` keys. When a key is set, the workflow uses **batch mode**: draft each section between gates in order without stopping, then pause for human approval at the configured gate.

## How it works

- Unknown keys are silently ignored.
- Keys not applicable to the current workflow (e.g., `personas` in an enhancement spec) cause the workflow to pause at the next applicable section instead.
- Multiple keys may be set; each triggers its own gate.
- When the gate is hit, present everything completed since the previous gate as one consolidated output, then stop with:

  > "I've completed [section list]. Review above and reply **continue** to proceed to [next stage/section]."

## Key table

| Key | Pauses before | Stages it applies to |
|---|---|---|
| `product_requirements` | Writing the product requirements artifact (what/why/goals) | product-requirements |
| `what` | Writing the "What" section | product-requirements, enhancements |
| `why` | Writing the "Why" section | product-requirements, enhancements |
| `goals` | Writing the "Goals" section | product-requirements, enhancements |
| `personas` | Writing the personas section | product-requirements |
| `narratives` | Writing the narratives section | product-requirements |
| `user_stories` | Writing the user stories section | product-requirements, enhancements |
| `non_functional_requirements` | Writing the non-functional requirements section | product-requirements, enhancements |
| `enhancement_requirements` | Writing the enhancement requirements artifact | enhancements |
| `summary` | Pauses before writing the "Summary" section | enhancements |
| `current_behavior` | Writing the "Current behavior" section | enhancements |
| `proposed_behavior` | Writing the "Proposed behavior" section | enhancements |
| `adrs` | Writing or extracting Architecture Decision Records | adrs |
| `design_spec` | Writing the design specification artifact | design-specs |
| `user_flows` | Writing the user flows section | design-specs |
| `screens` | Writing the screens/wireframes section | design-specs |
| `components` | Writing the components/interaction section | design-specs |
| `accessibility` | Pauses before writing the accessibility and responsive behavior section | design-specs |
| `design_system_updates` | Writing the design system updates section | design-specs |
| `tech_spec` | Writing the technical specification artifact | tech-specs |
| `architecture` | Writing the architecture section | tech-specs |
| `data_model` | Writing the data model section | tech-specs |
| `api_contracts` | Writing the API contracts section | tech-specs |
| `implementation_plan` | Writing the implementation plan section | tech-specs |
| `testing_strategy` | Writing the testing strategy section | tech-specs |
| `tasks` | Writing the task decomposition artifact | task-decomposition |
| `stories` | Writing the stories grouping section | task-decomposition |
| `leaf_tasks` | Writing the leaf tasks (after stories are approved) | task-decomposition |
| `dependencies` | Writing the dependency graph section | task-decomposition |
| `bug_triage` | Writing the bug triage artifact / issue | bug-triage |
| `root_cause` | Writing the root cause analysis section | bug-triage |
| `bug_tasks` | Writing the bug task list | bug-triage |

## Behavior when no key matches

- If `waitForApprovalBefore` is absent or `[]`, use the standard per-section checkpoints: pause after every section.
- If `waitForApprovalBefore` is set but no key matches an applicable section in the current stage, the entire stage is drafted in one batch and presented at the end.
