# Implementation review results concept proposal (#164)

For `docs.human_review`. This build workflow does not include that gate, so this proposal leaves
`context-human/` unchanged. Review the stored-guide description with the
[#163 concept proposal](testing-guide-concept-proposal.md).

```diff
--- a/context-human/concepts/acceptance-testing.md
+++ b/context-human/concepts/acceptance-testing.md
@@ -20,8 +20,8 @@
 
 When the build is ready, the run reaches `implementation.human_review` and pauses for a person. The
 person exercises the change by hand and dispositions the result: the change passes and the run advances
-toward a PR, or it needs work and the run goes back to revise. The run cannot advance out of this gate,
-or reach `done`, while testing has open `Feedback` against the implementation. Manual human testing is
+toward a PR, or it needs work and the run goes back to revise. A failed check or blocking implementation
+`Feedback` holds the gate. Manual human testing is
 the default: a deliberate posture for the work this product does now, where a person running the change
 and judging it is the trustworthy signal rather than a gap waiting to be filled with automation.
 
@@ -33,10 +33,9 @@
 `Feedback` is the actionable part. (The `TestResult` entity is owned by the `domain-model` catalog; this
 concept describes what it holds and how the gate uses it — see Relationships.)
 
-A run's gate can be exercised more than once. When testing surfaces problems, the run goes back to
-revise and returns to the gate for another pass; each pass that a person performs produces its own
-test-result record, so the run keeps a timeline of how testing went rather than a single overwritten
-verdict.
+Each decided review pass with a guide keeps its own final result, even when two passes use the same
+guide revision. The final result names the person who made the decision. Leaving the gate without a
+decision discards the draft for that pass and keeps prior final results.
 
 ## Feedback holds the gate
 
@@ -45,12 +44,11 @@
 advance, and a `revise` directive sends the run back to its producing step to address them. Gating is
 exactly as the feedback concept sets it: every item for the implementation target dispositioned
 (resolved or `wont_fix`), the originator confirming the fixes they raised. The acceptance-testing
-concept does not invent its own gating rule; it relies on the one feedback already owns.
+concept applies that lifecycle to both general feedback and feedback created from failed checks.
 
-The test-result record and the `Feedback` play distinct parts. The test-result says testing was done
-and how it went; the feedback says what to change. A pass with no feedback is a test-result with nothing
-to fix and an open advance; a pass with feedback is a test-result that references items the run must
-work through before it returns.
+The test-result records the marks and notes. `Feedback` records what to change. When the person sends
+a build back, each failed check becomes a feedback item, and the final result links to those items and
+any other open implementation feedback.
 
 ## The testing guide
 
@@ -78,10 +76,12 @@
 General feedback is target-level `Feedback` against the implementation (`feedback`), so it holds the gate
 like any other item and goes to the implementation when the run revises.
 
-The item marks and notes belong to that pass's test-result record, so the record shows how each item
-went. They do not replace the `Feedback` rows, which stay the one place an item of feedback is
-dispositioned. The control plane exposes the guide, its items, and the results of a pass through the run
-(`api`).
+A failed mark blocks approval. A note on a passed or unanswered check does not block approval. On
+send-back, those notes go to the implementer as context and require no disposition.
+
+The next pass carries passed marks and notes on passed or unanswered checks whose IDs still match.
+Failed checks start unanswered without their old notes. New and rewritten checks start empty. The
+control plane exposes the current pass and the history through the run (`api`).
 
 ## Evidence
 
--- a/context-human/concepts/run-detail.md
+++ b/context-human/concepts/run-detail.md
@@ -107,7 +107,5 @@
 
 - **The docs gate and the pauses for input** use the same decision button and comment model, taken up when
   operators need a screen for them.
-- **Recording test results** needs a route for the testing guide's results, taken up when the Acceptance
-  tab records them.
 - **Other kinds of item** can use the same pane with their own tabs, taken up when the client shows items
   other than runs.
```
