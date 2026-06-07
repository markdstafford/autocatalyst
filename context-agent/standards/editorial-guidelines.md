# Editorial guidelines

For an **editorial pass** over the committed corpus (`concepts/`, `adrs/`, standards, indexes). One
agent per document, in parallel.

## The hard rule: editorial only — do NOT change substance

**Change wording, not meaning.** This pass removes AI-tells and applies house style. It does **not**
alter a decision, a tradeoff, a constraint, an entity/field, a cross-reference target, or anything a
reader would act on differently. If improving the prose would change the meaning, **stop and flag it**
— do not make the change.

- **Editorial change** (apply directly): tropes, filler, magic adverbs, em-dash splices, define-by-
  negation phrasing, burying the lead, heading case, straight-quotes/ASCII, tightening.
- **Meaningful change** (DO NOT apply — record for human/reconciliation): anything that shifts what the
  doc asserts, adds/removes a claim, or reinterprets a decision. List these in your change summary as
  "flagged, not applied."

Preserve exactly: all citations (`(v0: …)`, `ADR-NNN`, cross-refs), code/identifiers in backticks,
frontmatter, section structure and ordering, and every technical term. Bump `last_updated` only if you
touched the file.

## Precedence
1. **`mm:writing-guidelines`** (the skill) — authoritative. Where anything below conflicts with it, it wins.
2. **The established rules** (below) — set during these sessions; enforce them.
3. **tropes.fyi** — **directional only.** Absorb the *principle* (remove AI-tells; write like a varied,
   specific human), not its exact word list. Our banned set is our own; do not import bans that fight
   the established rules (e.g. technical terms, or `->`/arrows used inside code).

## Established rules (enforce)
- **Present-tense, from-scratch voice.** No `v0`/predecessor/"rebuild"/"migrating-away" framing; a
  rejected approach may appear as an *alternative* without migration framing.
- **No define-by-negation in a Decision section.** State what the model *has*; a contrast against a
  rejected option lives in Alternatives. (A positive rule phrased as a negative — "X is never used for
  Y" — is fine; asserting the *absence* of an alternative's feature in the Decision is not.)
- **Capability-gated, not timeline, framing.** "A deferred option, taken when X" — not "X now, Y later."
- **No phasing words in concepts/ADRs.** Phasing/sequence lives only in the gitignored classification docs.
- **`ADR-NNN` hyphenated; ADR status `proposed`→`accepted`, never `superseded`.**
- **Sentence-case headings.** Backticks for code/paths/identifiers. Parallel structure in lists.
  Consistent terminology (match the committed canonical vocabulary verbatim).
- **Don't bury the lead.** The first sentence of a doc/section states its point; orientation before detail.
- **Banned stems — grep by STEM, twice (after first edit and after final):** `v2`, `OMC`, `v0`,
  `migrat`, `rebuil` (catches `rebuilt`), `parit`, `clean`, `eleg`, `crisp`. Plus banned phrases:
  `load-bearing`, `smoking gun`, `falls out`, `earns its place`, `slick`.

## Tropes to remove (the high-frequency offenders in this corpus first)
- **The ADR "forces" cargo-cult.** Around ADR-024 the Context sections began listing "N forces shape
  the design" and every later ADR copied it. Vary the rendering; state the actual context plainly. Do
  not cargo-cult a recent doc's structure. (This is the single most important target.)
- **Em-dash addiction.** A splice or dramatic pause every few lines. Keep the few that genuinely aid a
  parenthetical; rewrite the rest into plain sentences.
- **Negative parallelism / reframes.** "It's not X, it's Y", "not because X but because Y", "The
  question isn't X. It's Y", "Not A. Not B. Just C." Replace with the direct statement.
- **The "serves as / stands as / represents / marks" dodge.** Use `is`/`are`.
- **Magic adverbs & intensifiers:** `quietly`, `deeply`, `fundamentally`, `remarkably`, `arguably`,
  `simply`, `seamlessly`. Cut or replace with a concrete claim.
- **Filler transitions:** "It's worth noting", "Importantly", "Interestingly", "Notably", "Here's the
  thing/kicker", "Let's unpack/break this down/dive in." Delete; connect the point directly.
- **Superficial `-ing` tails:** "…, highlighting its importance", "…, reflecting broader trends", "…,
  underscoring its role." Cut — they assert significance without adding any.
- **Rhetorical Q&A:** "The result? Devastating." Make it a statement.
- **Manufactured-emphasis fragments:** one-word/one-clause paragraphs for drama. Fold into real sentences.
- **False ranges:** "from X to Y" where X and Y aren't on a real scale — just name the things.
- **Tricolon / anaphora stacking:** back-to-back rule-of-threes or repeated sentence openings. Vary.
- **Grandiose stakes / "the truth is simple" / vague attributions ("experts say")** — out of place in a
  technical doc; state the specific, grounded claim.
- **Invented rhetorical labels** ("the supervision paradox") used as if established — only keep a coined
  term if the doc actually defines and uses it as a real concept.
- **Unicode decoration:** prefer ASCII — straight quotes `"` `'`, `->`/`=>` only inside code; avoid
  decorative arrows/smart-quotes in prose.
- **Signposted conclusions** ("In conclusion", "To sum up") and **fractal summaries** (a summary at
  every level) — technical docs rarely need either.

> A single instance of any pattern can be fine. The problem is repetition and clustering. Aim for prose
> that reads as a varied, specific human wrote it — terse, present-tense, concrete.

## Process (per document)
1. Read the doc. Note its lead — fix it first if buried.
2. Apply editorial changes in place. Do not touch substance; flag meaningful issues instead.
3. Grep by stem (twice) for the banned set; confirm zero before claiming done.
4. Return a per-doc change summary: the categories of edits made + any "flagged, not applied" meaningful
   issues for human/reconciliation. Keep the diff editorial.
