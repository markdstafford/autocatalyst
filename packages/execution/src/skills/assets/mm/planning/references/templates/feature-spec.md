---
name: <feature name>
slug: <feature-slug>
type: feature
date: <YYYY-MM-DD>
status: Draft   # Draft | Approved | Implemented | Superseded
owner: <human name>
related_adrs: []
related_features: []
---

# <feature name>

## What

<One paragraph describing the feature at the level of observable user-visible behavior. No implementation.>

## Why

<The user problem, business need, or strategic goal this feature serves.>

## Goals

- <Observable, measurable outcome 1>
- <Observable, measurable outcome 2>
- <Observable, measurable outcome 3>

## Personas

### <persona name>

- **Role:** <what they do>
- **Cares about:** <what matters to them in this context>
- **Constraints:** <skill, environment, frequency of use>

## Narratives

### <Persona> — <vignette title>

<One- or two-paragraph narrative in present tense showing the persona using the feature.>

## User stories

- As a <persona>, I want to <action>, so that <outcome>.
- As a <persona>, I want to <action>, so that <outcome>.

### Future (out of scope for this iteration)

- As a <persona>, I want to <action>, so that <outcome>.

## Non-functional requirements

- **Performance:** <e.g., p95 latency under 200 ms>
- **Scale:** <e.g., supports 10k concurrent users>
- **Security:** <e.g., authenticated endpoints only>
- **Accessibility:** <e.g., WCAG 2.1 AA>
- **Other:** <as needed>

## Out of scope

- <Thing that might be assumed in scope but is not>
- <Thing that might be assumed in scope but is not>

## Design

<Filled in during the design specs stage. Includes user flows, screens, components, accessibility notes, design system updates.>

## Technical specification

<Filled in during the tech specs stage. Includes architecture, data model, API contracts, implementation plan, testing strategy, operational concerns, open questions.>

## Tasks

<Filled in during task decomposition. Hierarchical: stories grouping leaf tasks, each with description, acceptance criteria, dependencies.>
