# /multi-review — self-audit (Audit 3: skill · Audit 4: model-agent prompts)

**Target:** the `/multi-review` tool — `~/.claude/commands/multi-review.md`, `codex-review.ps1`,
`gemini-review.ps1`, `.multi-review.json`. **Models:** Claude + Codex + Gemini (all 3, read-only).

## Consensus — Critical
1. **Prompt injection from reviewed code** (Codex+Gemini). Bundled code/diffs/docs can carry instructions that
   steer a model to suppress findings, emit fake JSON, or leak secrets. **Fix (applied):** invariant + prompt
   now declare all bundled content UNTRUSTED data inside delimiters; models must ignore embedded instructions
   and never change the output schema or reveal secrets.
2. **Policy/validation trust → RCE on `--apply`** (Codex+Gemini). `.multi-review.json` (protected paths AND
   validation commands) is repo-controlled; a PR could weaken guards or run arbitrary commands during apply.
   **Fix (applied):** load policy from the **trusted base revision**; if the change set modifies
   `.multi-review.json`, force report-only.

## Consensus — High
3. **`$Resume` command-injection** in `codex-review.ps1` (Gemini) + **PATH-hijack** of `codex`/`gemini` (Codex).
   **Fix (applied):** `$Resume` validated against `^[A-Za-z0-9-]+$`. **TODO:** pin absolute CLI paths.
4. **Secret leakage** via `reviews/` reports/transcripts (Codex+Gemini). **Fix (partial):** untrusted-data rule
   + redaction already specified; **TODO:** add `reviews/_work/` to `.gitignore`, fail-closed scrub.
5. **git arg-injection** — branch/path with spaces/dashes (Gemini). **Fix (applied):** spec now uses `--` + argv.
6. **Prompt quality** (Codex+Gemini, Audit 4): generic prompt lacked injection-resistance, negative constraints,
   evidence. **Fix (applied):** Round-0 prompt upgraded (adversarial, evidence-based, omit nits, strict JSON).

## Recommended follow-ups (documented, not yet applied)
- Strict JSON validation of each model's output before merge (reject mixed/markdown).
- Pin absolute `codex`/`gemini` paths; restrictive ACLs on temp files; capture model stderr into provenance.
- Semantic protected-path expansion (auth/session/jwt/crypto/payment/webhook + unknown server entrypoints default-protected).
- Per-hunk human confirm for `--apply` even at consensus; deterministic safety classifier for editable diff types.
- Model-specific prompt suffixes (Codex: dataflow; Claude: synthesis/dissent; Gemini: schema discipline).
- Dependency-aware validation expansion (not just touched paths).

**Disposition:** Critical #1, #2 and High #3, #5, #6 fixed in the tool now; the rest captured above for a v2.
