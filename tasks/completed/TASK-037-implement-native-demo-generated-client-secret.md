# TASK-037: Implement generated CLIENT_SECRET placeholder for native local-login demos

Owner role: Implementer
Assigned agent: openai-coder (Codex), completed by Claude after the Codex
run stalled (2026-11-02)
Proposed by: Claude (TASK-035 follow-up)
Proposed date: 2026-11-02
Approved by: Patrick
Approved date: 2026-11-02
Related contracts: CONTRACT-015 (§4, §4a, Postconditions and invariants,
Failure behavior, Interfaces, UX expectations, Validation requirements);
CONTRACT-008 (§4 as superseded, §6, §7.4 unchanged); CONTRACT-014 §7.2,
§7.3 (unchanged)
Related ADRs: ADR-001
Dependencies: CONTRACT-015 approved (done 2026-11-02).

## Desired outcome

A native `LOCAL_LOGIN=true` install can be seeded without the operator
inventing a `CLIENT_SECRET`, and can later switch to Entra by replacing the
generated placeholder, exactly as CONTRACT-015 specifies. Container
behavior is unchanged.

## Context

`src/seed.ts` stores `CLIENT_SECRET` whenever it is unseeded, prompting for
it or reading `--client-secret-file`, whatever `LOCAL_LOGIN` is, and stores
an empty value without complaint. CONTRACT-015 replaces CONTRACT-008 §4 and
records Patrick's decisions in its Resolved decisions #3 to #10.

## Scope

### Included

- `src/seed.ts` / `scripts/seed.js`: empty entry at the hidden prompt with
  `LOCAL_LOGIN=true` generates a placeholder; `--generate-client-secret`;
  `--replace-client-secret` (native only, placeholder only, by prompt or
  `--client-secret-file`); the usage-error combinations in CONTRACT-015's
  Failure table; refusing empty and reserved (prefix) operator input in
  every native path.
- Generation per CONTRACT-015 "Generated placeholder": Node `crypto`, at
  least 32 random bytes, base64url or hex, behind a fixed documented
  prefix; never printed, logged or written anywhere except encrypted in
  `secrets`.
- Startup (§4a): refuse `LOCAL_LOGIN=false` with a placeholder stored, with
  the native or container message as specified; one informational line
  with `LOCAL_LOGIN=true` and a placeholder stored; native local mode still
  starts with no or undecryptable `CLIENT_SECRET`.
- New isolated test script(s) in the style of `scripts/test-*.js` covering
  every CONTRACT-015 Validation requirements bullet.
- `docs/DEVELOPMENT.md` (and any operator docs that describe seeding):
  the demo seed, the prefix, and switching to Entra.

### Excluded

- Any container change: entrypoint, `--non-interactive` seed (CONTRACT-008
  §7.4), CONTRACT-014 inputs.
- General rotation of an operator-supplied `CLIENT_SECRET`.
- Schema changes, admin-console or HTTP exposure of placeholder status.
- Editing any contract.

## Plan

1. Read CONTRACT-015 in full and the current `src/seed.ts`, startup check
   and `SecretsStore` code.
2. Implement the seed changes and the prefix check, keeping CONTRACT-008's
   unlink-or-abort, fully-seeded and interruption behavior intact.
3. Implement the §4a startup behavior.
4. Add the tests; run them and every existing test script.
5. Update docs; record the handoff and move to `review/`.

## Acceptance criteria

- [ ] Every CONTRACT-015 Failure behavior row the seed script or startup
      can hit behaves as specified (exit non-zero, nothing written or
      changed where stated).
- [ ] A generated placeholder never appears in stdout, stderr, logs or any
      file other than its encrypted `secrets` row (verified by decrypting
      in the test and searching captured output).
- [ ] Container mode and `--non-interactive` never generate; both new flags
      are refused there; `scripts/test-container-deployment.js` passes
      unchanged.
- [ ] `--replace-client-secret` replaces only a placeholder, leaves signing
      keys and local users unchanged, and advances `updated_at`.
- [ ] Startup refuses `LOCAL_LOGIN=false` with a placeholder stored and
      succeeds after replacement; `LOCAL_LOGIN=true` logs one line.
- [ ] Empty and prefixed operator input is refused in every native path,
      including `LOCAL_LOGIN=false` (intentional change, Resolved
      decision #7).
- [ ] The prefix string is documented; DEVELOPMENT.md describes the demo
      seed and the switch to Entra.
- [ ] All existing test scripts pass.

## Validation requirements

CONTRACT-015 "Validation requirements" in full, plus CONTRACT-008's seed
regression bullets. Tests use temporary PGlite directories only. Human
review: Patrick runs one native demo seed (Enter at the prompt) and one
replacement and confirms the messages read clearly.

## Risks and assumptions

- Native local-mode startup must now read `CLIENT_SECRET` to log the
  informational line; a read or decrypt failure there must not fail
  startup.
- Changing the `LOCAL_LOGIN=false` empty-input behavior could affect a
  scripted install that relied on storing an empty secret; none is known.

## Blocker

None.

## Implementation handoff

Task: TASK-037
Implementer: openai-coder (Codex) for the bulk of the change; Claude reviewed
it against CONTRACT-015, fixed one gap, ran all validation and wrote this
handoff after the Codex run stalled and was stopped at Patrick's request.
Date: 2026-11-02

### Changes made

- `src/clientSecretPlaceholder.ts` (new): the fixed prefix
  `orca-generated-placeholder.`, `isGeneratedClientSecret`, and
  `checkClientSecretPlaceholder` (§4a: throws the native or container
  refusal with `LOCAL_LOGIN=false`; returns true with `LOCAL_LOGIN=true`;
  a missing or undecryptable value returns false so native local startup
  is unaffected).
- `src/seed.ts`: `--generate-client-secret`, `--replace-client-secret`;
  empty (after trim) hidden-prompt entry generates when `LOCAL_LOGIN=true`,
  with the explanation line; 32 bytes from `crypto.randomBytes`, base64url,
  behind the prefix; CSPRNG failure aborts with nothing written;
  `validateOperatorSecret` refuses empty and prefixed operator input in
  every native path (prompt, file after unlink, replacement); usage errors
  for both flags with `--non-interactive` or in container mode, generate
  with replace or with `--client-secret-file`, and (Claude) replace with
  `--local-user-file`. Replacement reads only `CLIENT_SECRET`, refuses when
  absent or operator-supplied, and writes one upsert (`updated_at = now()`).
  The `--non-interactive` path is unchanged.
- `src/index.ts`, `scripts/startup-check.js`: call the §4a check before the
  server listens; `index.ts` logs the one informational line.
- `scripts/test-native-demo-secret.js` (new): isolated tests (temporary
  PGlite dirs, isolated `HOME`, real PTY for the hidden prompt, fault
  injection for CSPRNG, unlink and SIGKILL).
- `start.ps1`: seed hint mentions pressing Enter in local-login mode.

### Validation performed

- `npm run build`: succeeded.
- `node scripts/test-native-demo-secret.js`: 54 passed, 0 failed. Covers
  every CONTRACT-015 Validation requirements bullet: interactive and flag
  generation, two generations differ and carry 32 bytes, operator values
  stored unmarked, every seed-reachable Failure row with `secrets`,
  `signing_keys` and `local_users` compared before/after, the
  generate-plus-file conflict leaves the file, container and
  `--non-interactive` refusals, container missing/supplied `CLIENT_SECRET`,
  replacement by prompt and file (keys and users unchanged, `updated_at`
  advanced, input deleted), replacement while the service runs, startup
  refusal (native and container messages) and success after replacement,
  one informational line in local mode, native local startup with missing
  and undecryptable values, and the leakage check (decrypted placeholders
  and their random parts absent from all captured output and every file
  written in the scratch dir, `ps` check, isolated shell history).
- Regression, all exit 0: `test-admin-console.js`, `test-api-docs.js`,
  `test-console-sign-in.js`, `test-container-deployment.js`,
  `test-local-password-change.js`, `test-local-registration.js`,
  `test-proxy-only.js`, `test-trusted-proxies.js`, `verify-offline.js`.
- Not run: `scripts/test-container-image.sh` (needs Docker and an image
  build); no container file changed.
- Not done: Patrick's human review (one native demo seed and one
  replacement).

### Acceptance criteria evidence

All eight criteria are covered by the tests above; the prefix is
documented in `docs/DEVELOPMENT.md`.

### Assumptions and deviations

- `--replace-client-secret` with `--local-user-file` is a usage error,
  checked before any file is read. CONTRACT-015 lists only
  `--client-secret-file` for replacement and says replacement touches
  nothing else; without the check, the plaintext local-user file was left
  unread on disk.
- In `--non-interactive` (container) mode a `CLIENT_SECRET` env value is
  not checked for emptiness or the prefix beyond the existing "missing"
  rule, since CONTRACT-008 §7.4 is unchanged.

### Unresolved risks

- A scripted `LOCAL_LOGIN=false` native install that relied on storing an
  empty secret now fails (intended, Resolved decision #7).
- A prompt entry of only whitespace with `LOCAL_LOGIN=true` generates,
  matching "empty after trimming whitespace".

### Documentation updated

`docs/DEVELOPMENT.md` (native demo seed and switching to Entra; Windows
seed note), `README.md` (pointer), `start.ps1` (seed hint).

## Review

Not reviewed.
