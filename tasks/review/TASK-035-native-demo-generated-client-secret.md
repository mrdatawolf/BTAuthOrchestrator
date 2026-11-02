# TASK-035: Contract — generated CLIENT_SECRET for native local-login demos

Owner role: Contract designer
Assigned agent: TBD
Proposed by: Patrick Moon (decision during TASK-031 review, 2026-10-29)
Proposed date: 2026-10-29
Approved by: Patrick
Approved date: 2026-10-29
Related contracts: CONTRACT-008 (§4 bootstrap/seed interface, §7.4);
CONTRACT-013 §8 (local-only profile); CONTRACT-014 §7.2
Related ADRs: ADR-001
Dependencies: CONTRACT-013 and CONTRACT-014 approved. Sequence with TASK-030
so that two supersessions of CONTRACT-008 never run at once.

## Desired outcome

A native (non-container) local-login demo install can be seeded without the
operator inventing a `CLIENT_SECRET` it will never use. Container installs
are unchanged: the operator must always supply `CLIENT_SECRET`.

## Context

`scripts/seed.js` stores `CLIENT_SECRET` whenever it is unseeded, prompting
for it (or reading `--client-secret-file`), whatever `LOCAL_LOGIN` is
(`src/seed.ts` around line 135). The secret is only used for Entra sign-in,
so a `LOCAL_LOGIN=true` demo has to be given a dummy value.

Patrick decided (2026-10-29): in a native demo, the seed may set
`CLIENT_SECRET` to a random value; in a Docker container, the user must
supply one (CONTRACT-014 §7.2, unchanged).

## Scope

### Included

- A contract change, by supersession under ADR-001, to CONTRACT-008's seed
  interface defining when the native seed generates a random
  `CLIENT_SECRET`. Questions to settle:
  - What counts as "demo": `LOCAL_LOGIN=true` alone, an explicit flag or
    prompt choice, or both?
  - Interactive seed: offer "generate a random value" at the prompt, or
    generate silently?
  - Generation: length and source (CSPRNG), never printed or logged.
  - Switching the install to Entra later: the operator replaces the stored
    value with the real secret. How, and is it documented?
  - Startup or console indication that the stored secret is a generated
    placeholder?

### Excluded

- Implementation (a follow-up implementer task).
- Any change to container first-boot inputs.

## Plan

1. Contract designer drafts the superseding contract with open questions.
2. Patrick approves.
3. Implementer task follows.

## Acceptance criteria

- [ ] An approved contract specifies the native demo behavior and leaves
      container behavior unchanged.

## Validation requirements

Human review of the contract.

## Risks and assumptions

- A generated value that is later mistaken for a real Entra secret would
  make Entra sign-in fail with a confusing error.

## Blocker

None.

## Implementation handoff

Contract designer (ContractArchitect), 2026-10-30.

- Draft: `docs/contracts/CONTRACT-015-native-demo-generated-client-secret.md`,
  Status `Proposed`. Section-level supersession of CONTRACT-008 (§4 restated
  in full, the Scope exclusion on rotating `CLIENT_SECRET`, the third UX
  bullet, Resolved decision #11). CONTRACT-008 §7.4 and CONTRACT-014 are not
  changed. No other contract was edited; CONTRACT-008's "Superseded by" note
  is to be added only after approval.
- Behavior drafted: native `LOCAL_LOGIN=true` seed generates a CSPRNG
  placeholder (at least 256 bits, never shown) on an empty prompt entry or
  `--generate-client-secret`; container mode and `--non-interactive` never
  generate; the placeholder is recognizable; `--replace-client-secret`
  (native only, placeholder only) switches the install to Entra; startup
  refuses `LOCAL_LOGIN=false` with a placeholder stored.
- Open questions for Patrick (recommendation in brackets): OQ-1 what counts
  as demo [LOCAL_LOGIN=true plus explicit choice]; OQ-2 prompt form and flag
  names [empty Enter at the hidden prompt; names as drafted]; OQ-3 placeholder
  marker [reserved prefix inside the encrypted value]; OQ-4 switching to Entra
  [placeholder-only replace command]; OQ-5 empty/reserved operator input
  [refuse in every native path]; OQ-6 startup line in local mode [yes, one
  informational line]; OQ-7 placeholder found in a container [refuse with
  LOCAL_LOGIN=false, no container replace path]; OQ-8 supersession shape
  [section-level].
- Sequencing: approve one CONTRACT-008 supersession at a time with TASK-030.
- Task left in `in-progress/`; moving it to `review/` is for whoever owns the
  lifecycle step.

Update, 2026-11-02: Patrick answered OQ-1 to OQ-8, all as recommended
(OQ-1 (c), OQ-2 (a) with the drafted flag names, OQ-3 (a), OQ-4 (a), OQ-5
refuse empty in every native path, OQ-6 (a), OQ-7 keep the refusal, OQ-8
section-level). Recorded as CONTRACT-015 Resolved decisions #3 to #10; the
Open questions section and the "pending OQ-n" markers in the body are
removed, and the placeholder marker is now prescribed as a fixed prefix
inside the encrypted value. No behavior changed from the draft. CONTRACT-015
stays `Proposed`; CONTRACT-008's header is not yet edited. Moved to
`review/` for Patrick's approval of the contract.

## Review

Not applicable (contract-designer task; human approval of CONTRACT-015).
