# Cache-aware run cost baseline for #195

**Status: not measured.** The required representative bug and feature runs are not available.
This workspace has Codex CLI 0.171.0. The adapter pins 0.160.1 and rejects a version mismatch
before initialization; the production-account handshake and an ordinary parent launch could
not be verified here. The workspace has no approved live environment to launch a Claude run
or publish real rates. No rate, run, or session IDs were created for this baseline. Do not use
the synthetic fixture prices as live amounts or token shares.

## Repeat the comparison in an operator environment

1. Use the supported Codex release and the approved enterprise sign-in. Let the normal launcher
   confirm the exact provider and model. If the guard rejects a launch, inspect the installed
   version and thread/start confirmation. Do not override attribution or disable the guard.
2. Run one representative bug and one representative feature through normal dispatch, with
   normally recorded usage from both Codex and Claude across the two runs. Read each run's
   sessions and list the exact billing keys in the usage groups. Do not use the dispatch model as
   a substitute for an unknown served key.
3. Publish each provider's real USD list rates through POST /v1/configuration-records or
   the SDK's createConfigurationRecord method, using kind model_rate_table and action set.
   Choose an effective instant at or before the applicable session starts. Convert USD per million
   tokens to integer nano-dollars per token by multiplying by 1,000 exactly. Preserve all real
   context bands and cache-write retention rates. If correcting a slot, name its current
   revision in correctsId; retract a wrongly dated or keyed slot and publish the intended slot.
4. Refresh Summary or read GET /v1/runs/{id}/sessions again. Each priced amount uses API list
   price, not a subscription charge. Record each run and session ID, exact billing keys, four
   disjoint token classes, retention buckets reported, nano-dollar amount, effective dates,
   selected revision IDs, and gaps. Require a numeric amount from each adapter; document any
   remaining blocker instead of forcing a value.
5. For each adapter count exactly priced, estimated (by method), and unpriced tokens (by gap).
   Use known disjoint tokens as the denominator; reasoning and retention subsets do not add
   to it. Report unknown counts and legacy evidence separately without a percentage. Report
   amount overflow separately: it does not erase evidence or make those counts unknown.
6. Retain the returned session set and the selected immutable revisions. Retrieve revisions by ID
   and keep them with the evidence for offline reproduction. Apply each selected schedule to
   its original groups, using the same ceiling, hint, and treatment rules; compare session amounts
   and then sum representable session amounts. Do not rely on current rates or the time you ran
   the comparison to reconstruct an earlier read.

See [cost](../../context-human/concepts/cost.md) for the pricing rules.
