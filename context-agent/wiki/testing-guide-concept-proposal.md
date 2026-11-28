# Testing guide concept proposal (#163)

Proposed changes for `docs.human_review`. The build workflow does not currently include that gate.
Keep `context-human/` unchanged until a human approves the proposal.

## acceptance-testing.md

Replace the first two paragraphs under “The testing guide”:

> `implementation.testing_guide` reads the completed build and writes a guide before
> implementation review. The guide contains setup and run instructions and manual checks with
> expected results where useful. Each successful pass stores a complete revision under the run.
> You can read the latest revision after workspace reclamation. The guide is never committed or
> filed.
>
> Each check has a host-assigned ID. A check keeps its ID if its text and expected result match
> the preceding revision after Unicode normalization and whitespace folding. Case and the
> distinction between an absent and an empty expected result are significant. A check
> reintroduced after a gap gets a new ID. Feedback and test results are separate records.

Keep the existing paragraph about deriving review state from the run's step and `waiting_on`.

## domain-model.md

End “Publications” after the general explanation of the run-to-publication relationship. Replace
the text defining the guide as the publication of an embedded run result with this section:

> ## Testing guides
>
> A `TestingGuide` is a database record parented to a run and tied to the occurrence of
> `implementation.testing_guide` that produced it. It contains the revision number, instructions,
> and ordered checks. The latest revision can be read without the workspace. Earlier revisions
> keep their recorded content. See [acceptance testing](acceptance-testing.md) for check identity
> and review state. A testing guide is never committed or filed.

Add `TestingGuide` to the list of entities in “Persistence layout.”

## workflow.md

Add `implementation.testing_guide` to the catalog table and descriptions immediately after
`implementation.build`: phase `implementation`, waiting on `ai`, implementer only. Describe it
as a read-only authoring step that stores a revision and advances to implementation review.
Include it after the build in the feature, enhancement, bug, and chore build paths.

Rename the build section to “`build` is the last step that changes code.” Replace “Every
implementation path ends on `build`” with:

> `build` is the last step that changes code. `implementation.testing_guide` reads the final
> build and stores a complete guide before the implementation gate opens. Implementation feedback
> returns the run to `build` and produces another guide; a revision requested by `pr.finalize`
> returns directly to implementation review with the existing guide.
