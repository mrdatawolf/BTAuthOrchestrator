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

Not started.

## Review

Not reviewed.
