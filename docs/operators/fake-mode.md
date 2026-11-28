# Fake-mode testing guides

Start the fake control plane and seed an implementation-review run:

```sh
pnpm nx run control-plane:serve-fake
pnpm nx run control-plane:seed-fake -- --scenario implementation-review
```

Use the printed run ID with `GET /v1/runs/:id/testing-guide`, authenticated with
`Authorization: Bearer fake-mode-token`. The first successful guide is revision 1 (A–D).
Send a feedback reply at implementation review to run the build again. Revision 2 keeps A–C
word for word, rewrites D, and adds E. Revision 3 and later repeat revision 2 word for word.
The fixture pass follows the stored revision, so a failed author attempt does not consume a pass.

## Instructions and checks in the fixture

From the fake repository root, inspect the checked-out files:

```sh
git ls-files
```

| Pass | Check text | Expected result |
| --- | --- | --- |
| All | A. Find README.md in the file list. | README.md is listed. |
| All | B. Open README.md. | The file contains the fixture repository description. |
| All | C. Find fake-implementer-round-1.txt. | The scripted build file is present. |
| 1 | D. Open the scripted build file. | It contains deterministic implementer output. |
| 2+ | D. Check the first line of the scripted build file. | It reads: Deterministic fake-mode implementer output for round 1. |
| 2+ | E. Inspect the checked-out file list for a testing guide. | No testing guide is committed. |

## Fail one guide attempt

In the fake state directory, set `failures/issue-<number>.json` to
`{"step":"implementation.testing_guide"}` before the run reaches that step. The first matching
launch renames the file with a `.fired` suffix and fails. If no earlier guide exists, the guide
read returns `404`. Recover the run through the existing recovery endpoint to try again.
