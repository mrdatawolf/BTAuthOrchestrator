# CONTRACT-015: Generated CLIENT_SECRET placeholder for native local-login demos

Status: Approved
Approved by: Patrick
Approved date: 2026-11-02
Related tasks: TASK-035 (this contract's drafting task); a follow-up
implementer task (not yet created); TASK-006 and TASK-017 (built the seed
script this contract changes); TASK-025 (container image, unaffected);
TASK-030 (also expected to supersede part of CONTRACT-008; see "Sequencing")
Related ADRs: ADR-001, ADR-003
Supersedes: CONTRACT-008, only for the sections listed below.

1. Scope, Excluded: the bullet beginning "Rotating or updating
   `CLIENT_SECRET` after seeding, in any deployment mode."
2. Required behavior §4 (Bootstrap/seed interface), in full. §4 is restated
   below with the changes marked, so that the seed CLI is read in one place.
3. UX expectations: the third bullet, beginning "Distinct, plain-language
   messages exist for at least".
4. Resolved decision #11 (bootstrap script location and invocation).

Everything else in CONTRACT-008 remains in force, including §7.4
(non-interactive seed), which this contract does **not** change, and every
existing Failure behavior row and Validation requirement. This contract adds
Failure behavior rows, postconditions, invariants and validation bullets of
its own; it replaces none of CONTRACT-008's. CONTRACT-014 (container
profile, including §7.2's `CLIENT_SECRET` row) and CONTRACT-013 are not
changed.
Superseded by:

## Purpose

Patrick decided on 2026-10-29 (TASK-031 review, recorded in TASK-035): "in
demo mode let the `CLIENT_SECRET` be set with a random value. If it's a
docker container we should just require the user to give one."

Today `scripts/seed.js` stores `CLIENT_SECRET` whenever it is unseeded,
prompting for it or reading `--client-secret-file`, whatever `LOCAL_LOGIN`
is (`src/seed.ts`, the `!hasClientSecret` branch). The value is used only
for Microsoft Entra sign-in (`src/index.ts`, `/auth/callback`). A native
`LOCAL_LOGIN=true` demo therefore has to be given a dummy value the operator
invents. The native startup check already skips `CLIENT_SECRET` when
`LOCAL_LOGIN=true` (`scripts/startup-check.js`); the container startup check
always requires it.

This contract defines:

- when the **native** seed may store a randomly generated `CLIENT_SECRET`
  (a "generated placeholder") instead of an operator-supplied value;
- how the placeholder is generated, and that it is never shown;
- that the placeholder is recognizable as such, so that the service refuses
  to run Entra sign-in with it and the operator can replace it;
- a narrow, native-only command to replace a generated placeholder with the
  real Entra secret when the install moves to Entra;
- that container installs are unchanged: the operator always supplies
  `CLIENT_SECRET`, and the container never generates one.

### Relationship to CONTRACT-008

The superseded sections are listed in the header. Compared with them, the
complete list of behavioral changes is:

1. **Generation at first seed (native, `LOCAL_LOGIN=true` only).** The
   interactive prompt accepts an empty entry as "generate a placeholder", and
   a new flag `--generate-client-secret` does the same without a prompt (§4,
   "`CLIENT_SECRET` input").
2. **Placeholder marker.** A generated value is stored so that it can be
   told apart from an operator-supplied one (§4, "Generated placeholder").
3. **Replacement command.** A new native-only mode,
   `--replace-client-secret`, replaces a generated placeholder, and only a
   generated placeholder, with an operator-supplied value. This is the one
   exception to "the seed script is never the mechanism for changing
   `CLIENT_SECRET`" (§4, "Replacing a generated placeholder"; Scope).
4. **Empty and reserved input.** Empty input and input that would look like
   a placeholder are refused as operator-supplied values, in every native
   path.
5. **Startup refusal.** The service refuses to start with
   `LOCAL_LOGIN=false` while the stored `CLIENT_SECRET` is a generated
   placeholder (new section §4a).
6. **Output.** New confirmation lines and messages (§4 "Output", UX).

Everything else in §4 is carried forward verbatim.

### Sequencing

TASK-035's dependency note asks that two supersessions of CONTRACT-008 never
run at once. TASK-030 (audit retention contract) is approved but not
started. If TASK-030's contract also supersedes CONTRACT-008 sections,
Patrick approves the two one after the other, and the later one's header
names the earlier one's changes. The sections this contract supersedes (§4,
one Scope bullet, one UX bullet, Resolved decision #11) are not expected to
overlap with audit retention.

## Scope

### Included

- The native seed script's `CLIENT_SECRET` input, extended with generation
  for `LOCAL_LOGIN=true` installs.
- Generation requirements: source, strength, encoding, and never displaying
  or logging the value.
- Recognizing a stored generated placeholder.
- Replacing a generated placeholder with an operator-supplied value on a
  native install (this replaces CONTRACT-008's Excluded bullet on rotating
  `CLIENT_SECRET`, for this one case only).
- Startup behavior when a placeholder is stored and `LOCAL_LOGIN=false`, and
  the informational startup line when `LOCAL_LOGIN=true`.
- Operator documentation for the demo seed and for switching to Entra.

### Excluded

- Any change to container behavior: CONTRACT-008 §7.4's non-interactive
  seed, CONTRACT-014 §7.2's inputs (`CLIENT_SECRET` is required at first
  boot in every container install), the container entrypoint.
- General rotation of an operator-supplied `CLIENT_SECRET` (for example when
  an Entra client secret expires). This remains outside every contract, as
  CONTRACT-008 stated; it would need its own contract.
- Generating any other secret (`DB_ENCRYPTION_KEY` generation stays as
  CONTRACT-008 Resolved decision #17 defines it for `start.ps1`; tokens and
  the first local user are unchanged).
- Showing placeholder status in the admin console or any HTTP response.
- How the Entra sign-in flow uses `CLIENT_SECRET` (CONTRACT-001), other than
  the startup refusal in §4a.

## Actors

Unchanged from CONTRACT-008, with these clarifications:

- **Bootstrap operator** (native): runs `node scripts/seed.js` on a
  systemd or Windows host, interactively or with flags.
- **Container operator**: not affected. Cannot reach generation or
  replacement (§4, "Container mode").

## Inputs and outputs

**Inputs (new):**

- `LOCAL_LOGIN`, as loaded by the seed script from `.env` with the
  service's normal validation (CONTRACT-005 §10). Generation is available
  only when it is `true`.
- `--generate-client-secret` (flag, no value).
- `--replace-client-secret` (flag, no value).
- An empty entry at the interactive `CLIENT_SECRET` prompt.

**Outputs (new):**

- A stored `CLIENT_SECRET` row whose plaintext is a generated placeholder,
  recognizable as one (§4).
- New confirmation, warning and refusal messages (UX expectations). None of
  them contains the generated value or any operator-supplied value.

## Preconditions

CONTRACT-008's Preconditions are unchanged. In addition:

- The seed script reads `LOCAL_LOGIN` from the same configuration the
  service uses (`.env` on native installs). An invalid `LOCAL_LOGIN` already
  fails configuration loading before any seeding; that is unchanged.
- Replacement (`--replace-client-secret`) runs while the service is stopped.
  The single-process lock (CONTRACT-008 §6) enforces this; the precondition
  is documented so the operator expects it.

## Required behavior

### 4. Bootstrap/seed interface (supersedes CONTRACT-008 §4 in full)

Text marked **(unchanged)** is CONTRACT-008 §4 verbatim. Text marked
**(changed)** or **(new)** is this contract's.

**Invocation (unchanged).** A standalone script, invoked as
`node scripts/seed.js` from the repository root (TASK-006's implementation
may additionally alias this via an npm script, e.g. `npm run seed`, but
`scripts/seed.js` is the normative entry point this contract specifies; if
implemented in TypeScript, the compiled output must resolve to this
invocation). It is run manually, once, by the bootstrap operator, after
`.env` (including `DB_ENCRYPTION_KEY` and `PGLITE_DATA_DIR`) is in place and
TASK-005's schema has been applied, and before CONTRACT-001's login flow is
exercised for the first time.

**`DB_ENCRYPTION_KEY` is a precondition, not something this script
generates (unchanged).** The operator supplies it in `.env` before running
the script (e.g. via `openssl rand -hex 32`, non-normative guidance). The
script validates it per "Envelope encryption scheme" above and fails closed
if invalid.

**Determining what needs seeding (unchanged)**, on every invocation:
- If `secrets` has a row named `CLIENT_SECRET` **and** `signing_keys` has a
  row with `status = 'current'`: the database is already fully seeded. The
  script prints "Database already seeded; nothing to do." and exits with a
  non-zero status, making no writes. This is intentionally not a silent
  no-op success — a second accidental invocation must be visibly distinct
  from a successful first run.
- If exactly one of the two is missing (a prior run was interrupted after
  completing one part but not the other): the script seeds only the
  missing piece, leaves the existing piece untouched, and reports exactly
  what it did.
- If both are missing: full first-run bootstrap, both steps below.

(As built, `local_users` is a third piece under CONTRACT-005 §5; that is
unchanged. A stored generated placeholder counts as a `CLIENT_SECRET` row
for this check. The replacement mode below does not use this check.)

**`CLIENT_SECRET` input (changed)**, exactly one of:

- **Interactive prompt (default; changed).** A hidden-input prompt (input
  not echoed to the terminal, equivalent to a password prompt), read
  directly from the TTY. The value is never accepted as a bare CLI
  argument/flag value (e.g. `--client-secret=...`), since that would appear
  in shell history and in the process list (`ps`) of every user on the
  host.
  - **(new) When `LOCAL_LOGIN=true`:** before the prompt, the script prints
    that Microsoft Entra sign-in is off, so `CLIENT_SECRET` is not used, and
    that pressing Enter on an empty prompt generates a random placeholder.
    An entry that is empty after trimming whitespace stores a generated
    placeholder (see "Generated placeholder"). Any other entry is an
    operator-supplied value, subject to the reserved-value rule.
  - **(new) When `LOCAL_LOGIN=false`:** the prompt is unchanged and offers
    no generation. An empty entry is refused with a message
    asking for the Entra client secret; nothing is written.
- **One-time input file (`--client-secret-file=<path>`; unchanged except
  the empty/reserved rule).** For non-interactive/scripted bootstrap
  contexts (e.g. a value copied onto the host via `scp` ahead of running the
  script). The script reads the file's contents (trimmed of a single
  trailing newline if present) once, then immediately deletes (`unlink`s)
  the file before performing any further step. If the unlink fails, the
  script aborts immediately, writes nothing to PGlite, and prints an
  explicit error instructing the operator to delete the file manually — it
  never silently proceeds while a plaintext copy remains on disk. A file
  is always an operator-supplied value: an empty file never triggers
  generation: it is refused after the unlink, with nothing written.
- **Generate without prompting (`--generate-client-secret`; new).** Stores a
  generated placeholder without reading any input, so a scripted native
  demo bootstrap needs no `CLIENT_SECRET` file and no TTY for it (the first
  local user still comes from its prompt or `--local-user-file`).
  - Allowed only when `LOCAL_LOGIN=true`. Otherwise the script refuses
    before any write, saying generation is only for local-login installs
    and asking for the Entra secret through the prompt or
    `--client-secret-file`.
  - Mutually exclusive with `--client-secret-file`. Supplying both is a
    usage error detected before the file is read or deleted.
  - If `CLIENT_SECRET` is already stored, the flag has no effect. The
    script reports that `CLIENT_SECRET` is already stored and continues with
    any other missing piece. The fully-seeded rule above is unchanged.

**Reserved values (new).** An operator-supplied value, from the prompt or a
file, that begins with the placeholder prefix (see "Generated placeholder")
is refused with nothing written. This guarantees
that "is a placeholder" means "was generated by this script."

**Plaintext handling (changed: now also covers the generated value).** In
every path, the plaintext value, operator-supplied or generated, is held
only in local variables scoped to the seeding routine and is never written
to any temporary file, cache, or log. It is not needed once the
encrypt-and-store step for that value completes. (Node.js cannot guarantee
memory is zeroed after use; this is an accepted limitation, not a gap this
script is expected to close.)

**Generated placeholder (new).**

- **Source.** A cryptographically secure random source (Node's `crypto`
  module). A failure of that source aborts the run with nothing written. No
  fallback to a non-cryptographic source.
- **Strength and encoding.** At least 32 random bytes (256 bits), encoded
  with an alphabet that needs no quoting (base64url without padding, or
  lowercase hex), following the placeholder prefix.
- **Never shown.** The value is never printed, logged, written to `.env` or
  any file, included in an error message, or returned by any interface. The
  operator never needs it: it exists only so that `CLIENT_SECRET` is
  present.
- **Recognizable.** After storage, the seed script and the service can tell,
  using only PGlite and `DB_ENCRYPTION_KEY`, that the stored `CLIENT_SECRET`
  is a generated placeholder rather than an operator-supplied value. The
  marker is a fixed, documented, non-secret prefix at the start of the
  plaintext value (for example `orca-generated-placeholder.`), so it is
  stored inside the encrypted value. The implementer fixes the exact prefix
  string and documents it. Because the marker and value are one row, it
  persists across restarts, and replacement clears it in the same write
  that stores the new value, so the two can never disagree. A real Entra
  client secret never has this form.
- **Storage.** The same as any `CLIENT_SECRET`: encrypted per "Envelope
  encryption scheme" with AAD `'CLIENT_SECRET'`, written to `secrets`. No
  new table, row or column is added.

**`CLIENT_SECRET` storage (unchanged):** encrypt per "Envelope encryption
scheme" above (AAD `'CLIENT_SECRET'`) and write to `secrets`.

**Initial signing key generation (unchanged):** the script generates an
RS256 key pair in-process (2048-bit RSA; see "Resolved decisions"). The
plaintext private key never exists outside this process and is encrypted
immediately after generation, before any write to PGlite. The script assigns
a fresh `kid` (see "Resolved decisions" for the generation scheme) and
inserts a row with `status = 'current'`.

**Replacing a generated placeholder (`--replace-client-secret`; new).**

`node scripts/seed.js --replace-client-secret`, optionally with
`--client-secret-file=<path>`, replaces a stored generated placeholder with
an operator-supplied value. It is how a native demo install moves to Entra.

- **Only a placeholder.** If the stored `CLIENT_SECRET` is a generated
  placeholder, it is replaced. If the stored value is operator-supplied, the
  command refuses with nothing written: the seed script remains no
  mechanism for rotating a real secret. If no `CLIENT_SECRET` is stored, the
  command refuses and tells the operator to run the normal seed.
- **Input.** The hidden prompt or `--client-secret-file`, with §4's rules,
  including read-then-unlink-or-abort. No generation: an empty entry or
  empty file, or a reserved value, is refused with nothing written.
  `--generate-client-secret` with `--replace-client-secret` is a usage
  error.
- **Nothing else.** It does not seed, inspect or change signing keys or
  local users, and it does not apply the fully-seeded refusal.
- **Any `LOCAL_LOGIN` value.** It works whether `LOCAL_LOGIN` is currently
  `true` or `false`, so the operator may change `.env` first or last.
- **Atomic.** After an interruption, the stored row is either the old
  placeholder (still marked) or the new value (unmarked), never a mixture.
  `updated_at` reflects the replacement.
- **Service stopped.** It opens the database like every other seed run, so
  with the service running it fails fast with the existing second-instance
  error (CONTRACT-008 §6) and writes nothing.
- **Exit status.** 0 on replacement; non-zero on any refusal or failure.

**Container mode (new).** When container mode is on (CONTRACT-014 §7: set
explicitly by the image, today `BT_CONTAINER_MODE=1`, never detected by
heuristics):

- No `CLIENT_SECRET` is ever generated. CONTRACT-008 §7.4 and CONTRACT-014
  §7.2 apply unchanged: a missing `CLIENT_SECRET` at first boot is a missing
  seed input, whatever `LOCAL_LOGIN` is.
- `--generate-client-secret` and `--replace-client-secret` are usage errors,
  with nothing written. (The container already refuses any seed run without
  `--non-interactive`; this rule holds regardless of how that check is
  arranged.)
- `--non-interactive` never generates and never replaces, in any mode:
  supplying either new flag with `--non-interactive` is a usage error. This
  keeps §7.4 exactly as CONTRACT-008 defines it.
- An operator who turns container mode off by editing the form gets native
  behavior. That is CONTRACT-014 resolved question 5's accepted risk,
  unchanged.

**Output (changed).** On success, the script prints a confirmation naming
what was seeded (e.g. "CLIENT_SECRET stored." / "Signing key <kid> generated
and stored as current.") — never the secret value or private key material,
in success or error output, at any point. **(new)** A generated placeholder
is confirmed distinctly, for example: "CLIENT_SECRET set to a generated
placeholder (local login only). Before turning on Microsoft Entra sign-in,
stop the service and run: node scripts/seed.js --replace-client-secret". A
replacement is confirmed as, for example: "Generated CLIENT_SECRET
placeholder replaced. Set LOCAL_LOGIN=false, TENANT_ID and CLIENT_ID in
.env to use Microsoft Entra sign-in."

**Re-running (changed).** Re-running the normal seed is always safe in the
sense that it never silently overwrites or duplicates an existing
`CLIENT_SECRET` row (placeholder or not) or an existing `current` signing
key; it either completes the missing piece(s) of a partial bootstrap or
refuses entirely. Apart from `--replace-client-secret`'s placeholder-only
replacement, this script is a first-run bootstrap tool only — it is never
the mechanism for rotating `CLIENT_SECRET` or a signing key; signing-key
rotation uses the interface in "Interfaces", not this script.

### 4a. Startup with a stored placeholder (new)

- **`LOCAL_LOGIN=false` and the stored `CLIENT_SECRET` is a generated
  placeholder:** the service refuses to start, in every mode, before it
  accepts connections. The native message says the stored `CLIENT_SECRET`
  is a generated placeholder from a local-login demo seed and names
  `node scripts/seed.js --replace-client-secret` (with the service stopped).
  The container message follows CONTRACT-014 §7.3's rules (no shell
  command): it says the stored `CLIENT_SECRET` is a generated placeholder
  from a native demo install, and to replace it on that native install
  before moving the data, or to give the app a new, empty `/data` volume.
  There is no container replacement path. Neither message includes any
  secret.
- **`LOCAL_LOGIN=true` and the stored `CLIENT_SECRET` is a generated
  placeholder:** the service starts and logs one informational line, for
  example "CLIENT_SECRET is a generated placeholder; Microsoft Entra sign-in
  needs it replaced first (see docs)."
- **`LOCAL_LOGIN=true`, native, and `CLIENT_SECRET` missing or
  undecryptable:** unchanged. The native startup check does not require it
  today, and this contract adds no new failure in that case. Checking
  for a placeholder must not turn this case into a refusal.
- Startup behavior for operator-supplied values is unchanged.

## Postconditions and invariants

**After a successful seed run that generated a placeholder:**

- `secrets` has exactly one `CLIENT_SECRET` row, which is a recognizable
  generated placeholder.
- The generated value appeared in no output, log, file or `.env`.
- Container mode was off and `LOCAL_LOGIN` was `true` for that run.

**After a successful `--replace-client-secret`:**

- `secrets` has exactly one `CLIENT_SECRET` row, holding the
  operator-supplied value, not marked as a placeholder.
- No signing key or local user changed.
- The `--client-secret-file`, if used, no longer exists.

**Invariants:**

- A generated placeholder is never stored while container mode is on, or by
  `--non-interactive`.
- A generated placeholder is never stored when `LOCAL_LOGIN` was `false` for
  the seed run.
- An operator-supplied `CLIENT_SECRET` is never overwritten by any seed
  command.
- "Marked as a placeholder" holds exactly when the stored value was
  generated by the seed script and has not since been replaced.
- The service never runs with `LOCAL_LOGIN=false` and a placeholder stored.
- The generated value never leaves the seeding routine except as AES-256-GCM
  ciphertext in PGlite.

## Failure behavior

These rows are added to CONTRACT-008's table. Its existing rows, including
"already-fully-seeded" and "`--client-secret-file` cannot be deleted", apply
unchanged, also to `--replace-client-secret`.

| Condition | Required behavior |
|---|---|
| `--generate-client-secret` with `LOCAL_LOGIN=false` | Refuse before any write; exit non-zero; message says generation is only for `LOCAL_LOGIN=true` and asks for the Entra secret by prompt or `--client-secret-file`. |
| `--generate-client-secret` with `--client-secret-file` | Usage error before the file is read or deleted; nothing written; exit non-zero. |
| `--generate-client-secret` or `--replace-client-secret` with `--non-interactive`, or in container mode | Usage error; nothing written; exit non-zero. The container's first boot is unaffected because the entrypoint never passes these flags. |
| `--generate-client-secret` with `--replace-client-secret` | Usage error; nothing written; exit non-zero. |
| Interactive prompt, `LOCAL_LOGIN=false`, empty entry | Refuse; nothing written; exit non-zero; message asks for the Entra client secret. |
| Empty `--client-secret-file` (any `LOCAL_LOGIN`) | File is still deleted per §4; refuse; nothing written; exit non-zero; no generation. |
| Operator-supplied value is a reserved (placeholder-looking) value | Refuse; nothing written; exit non-zero; message does not echo the value. |
| Secure random source fails during generation | Abort; nothing written; exit non-zero. |
| Interrupted between generating and storing the placeholder | No row written; the next run treats `CLIENT_SECRET` as missing (CONTRACT-008's interruption row). |
| `--replace-client-secret`, stored value is operator-supplied | Refuse; nothing written; exit non-zero; message says only a generated placeholder can be replaced by this command. |
| `--replace-client-secret`, no `CLIENT_SECRET` stored | Refuse; nothing written; exit non-zero; message says to run the normal seed. |
| `--replace-client-secret` while the service is running | Existing second-instance error (CONTRACT-008 §6); nothing written. |
| `--replace-client-secret` interrupted | Stored row is either the marked placeholder or the new unmarked value. |
| Startup with `LOCAL_LOGIN=false` and a placeholder stored | Refuse to start before accepting connections; message names the replacement command (native) or follows CONTRACT-014 §7.3 (container). |
| Startup with `LOCAL_LOGIN=true` and a placeholder stored | Start normally; one informational line. |

## Interfaces

Operator-facing, normative:

- `node scripts/seed.js` (interactive): with `LOCAL_LOGIN=true`, an empty
  `CLIENT_SECRET` entry generates a placeholder.
- `node scripts/seed.js --generate-client-secret [--local-user-file=<path>]`:
  native, `LOCAL_LOGIN=true` only.
- `node scripts/seed.js --replace-client-secret [--client-secret-file=<path>]`:
  native only; replaces a generated placeholder only.
- `npm run seed` remains an alias that passes arguments through as today.
- `node scripts/seed.js --non-interactive`: unchanged (CONTRACT-008 §7.4,
  CONTRACT-014 Interfaces).

The module-boundary interface in CONTRACT-008 (`getSecret`, `setSecret`,
and so on) is unchanged. Whether "is a placeholder" is exposed through a
new function or checked inline against the decrypted value's prefix is
the implementer's choice; either way it is in-process only. No HTTP interface is added.

## UX expectations

This replaces CONTRACT-008's third UX bullet:

- Distinct, plain-language messages exist for at least: success (naming
  what was seeded); generated placeholder stored; already-seeded (no-op
  refusal); missing/invalid `DB_ENCRYPTION_KEY`; data-directory permission
  failure; `--client-secret-file` unlink failure; generation refused because
  `LOCAL_LOGIN=false`; conflicting flags; empty or reserved `CLIENT_SECRET`
  refused; placeholder replaced; replacement refused (operator-supplied
  value stored, or nothing stored); and startup refused because a
  placeholder is stored with `LOCAL_LOGIN=false`. An operator reading the
  output must be able to tell these apart without inspecting source code.

Additional expectations (new):

- The interactive explanation before the prompt appears only when
  `LOCAL_LOGIN=true`, and says in one or two lines what pressing Enter
  does and that the value can be replaced later.
- No message ever displays a generated or operator-supplied value, in part
  or in full, or its length.
- **Documentation (required deliverable of the implementer task):**
  - `docs/DEVELOPMENT.md` native seed section: the demo option, the
    `--generate-client-secret` flag, and that container installs always
    need `CLIENT_SECRET`.
  - A "Switching a local-login demo to Microsoft Entra" procedure: stop the
    service; run `node scripts/seed.js --replace-client-secret` (prompt or
    file); set `LOCAL_LOGIN=false`, `TENANT_ID`, `CLIENT_ID` and an issuer
    Entra accepts (CONTRACT-013 §8: plain HTTP only for `localhost`); start
    the service.
  - `start.ps1`'s "Answer its prompts (the Entra CLIENT_SECRET, ...)" text
    and the README mention that a local-login install may press Enter to
    generate a placeholder.
  - The container documentation keeps saying `CLIENT_SECRET` is required,
    local-login demos included.

## Validation requirements

Isolated tests in the style of the existing `scripts/test-*.js` files cover:

- **Interactive generation.** `LOCAL_LOGIN=true`, empty entry at the prompt:
  `CLIENT_SECRET` is stored and recognized as a placeholder; the explanation
  line appeared; captured stdout/stderr contain no part of the value (check
  by decrypting it in the test and searching the output).
- **Flag generation.** `--generate-client-secret` with `LOCAL_LOGIN=true` and
  `--local-user-file`, no TTY: seeds all pieces; same leakage check.
- **Strength.** Two generations against fresh databases produce different
  values; each carries at least 256 bits of randomness in the encoding
  chosen.
- **Operator value with LOCAL_LOGIN=true.** A non-empty prompt entry and a
  `--client-secret-file` are stored as operator-supplied (not placeholders).
- **Refusals.** Each row of this contract's Failure table that the seed
  script can hit: exit non-zero and no row added or changed (compare
  `secrets` before and after). For the `--generate-client-secret` plus
  `--client-secret-file` conflict, the file still exists afterwards.
- **Container unchanged.** With container mode on and `LOCAL_LOGIN=true`,
  the non-interactive seed without `CLIENT_SECRET` fails with the existing
  missing-input message and writes nothing; with `CLIENT_SECRET` supplied it
  stores an operator-supplied (unmarked) value. Both new flags are refused in
  container mode and with `--non-interactive`. `scripts/test-container-deployment.js`
  still passes unchanged.
- **Replacement.** Placeholder stored, then `--replace-client-secret` by
  prompt and by file: value replaced, unmarked, file deleted, signing keys
  and local users unchanged, `updated_at` advanced. Replacement against an
  operator-supplied value and against no value: refused, nothing changed.
  With the service running: second-instance error, nothing changed.
- **Startup.** Placeholder stored and `LOCAL_LOGIN=false` (with `TENANT_ID`
  and `CLIENT_ID` set): startup refuses with the replacement message; after
  replacement, startup succeeds. Placeholder stored and `LOCAL_LOGIN=true`:
  startup succeeds and logs the informational line. Native `LOCAL_LOGIN=true`
  with no `CLIENT_SECRET` row still starts as today.
- **Regression.** CONTRACT-008's seed validation bullets (interactive and
  file paths, shell history and `ps` check, unlink-or-abort, second-run
  non-zero exit, interruption) still pass; every existing test script still
  passes.

Human review: Patrick runs one native demo seed (press Enter at the prompt)
and one replacement, and confirms the messages read clearly.

## Resolved decisions

These replace CONTRACT-008's Resolved decision #11. Numbering is this
contract's own.

1. **Bootstrap script location and invocation** (replaces CONTRACT-008 #11).
   `node scripts/seed.js`, run manually from the repo root, with an
   optional `--client-secret-file=<path>` flag for non-interactive input;
   default behavior is an interactive hidden-input prompt. Native
   `LOCAL_LOGIN=true` installs may instead store a generated placeholder
   (empty entry at the prompt, or `--generate-client-secret`). Re-running is
   always safe (completes a partial bootstrap or refuses outright). The
   script is first-run-only, except that `--replace-client-secret` may
   replace a generated placeholder, and nothing else, with an
   operator-supplied value. It is not the mechanism for rotating an
   operator-supplied `CLIENT_SECRET` or a signing key.
2. **Generation only outside containers** (new). Decided by Patrick
   (2026-10-29). Native local-login demos may generate `CLIENT_SECRET`;
   container installs always require the operator to supply it (CONTRACT-014
   §7.2, unchanged).
3. **What counts as "demo"** (OQ-1, Patrick, 2026-11-02). Both conditions:
   generation is offered only when `LOCAL_LOGIN=true`, and the operator
   chooses it (empty entry at the prompt, or `--generate-client-secret`).
   No silent generation.
4. **Interactive form and flag names** (OQ-2, Patrick, 2026-11-02). An
   empty entry at the existing hidden prompt generates; there is no
   separate question. The flags are `--generate-client-secret` and
   `--replace-client-secret`.
5. **Placeholder marker** (OQ-3, Patrick, 2026-11-02). A fixed, documented,
   non-secret prefix at the start of the encrypted value. No marker row and
   no schema change.
6. **Switching to Entra** (OQ-4, Patrick, 2026-11-02).
   `--replace-client-secret`, native only, replaces a generated placeholder
   and nothing else. General `CLIENT_SECRET` rotation (for example on Entra
   secret expiry) stays out of scope and would be its own task.
7. **Empty and reserved operator input** (OQ-5, Patrick, 2026-11-02).
   Refused in every native path: the prompt with `LOCAL_LOGIN=false`, any
   `--client-secret-file`, and replacement. This intentionally changes the
   current `LOCAL_LOGIN=false` behavior, which stored an empty value, and
   matches CONTRACT-008 §7.4's "an empty `CLIENT_SECRET` counts as missing".
   Values beginning with the placeholder prefix are refused the same way.
8. **Startup line in local mode** (OQ-6, Patrick, 2026-11-02). With
   `LOCAL_LOGIN=true` and a placeholder stored, the service logs one
   informational line. A missing or undecryptable value still does not
   fail native local-mode startup.
9. **Placeholder found in a container** (OQ-7, Patrick, 2026-11-02). The
   `LOCAL_LOGIN=false` startup refusal applies in every mode. There is no
   container replacement path; the container message points to the native
   install or a new, empty `/data` volume.
10. **Supersession shape** (OQ-8, Patrick, 2026-11-02). Section-level, as
    listed in the header. On approval, CONTRACT-008's header gets a
    "Superseded by: CONTRACT-015 for ..." note in the same form as its
    CONTRACT-014 note; its body is not edited.
