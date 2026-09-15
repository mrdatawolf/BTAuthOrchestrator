# BTAuthOrchestrator — Founding Notes

Status: Day one. This is a planning document, not a spec — it exists so work
can start from a shared understanding instead of a blank repo. Expect it to be
superseded by proper docs (README, ADRs, task files) as the project grows.

Last updated: 2026-08-11

## 1. Purpose

BTAuthOrchestrator is the unified authentication service for the org's
internally-built tools. Today, each tool (starting with CDMS) rolls its own
local username/password login with its own user table. That doesn't scale
past one app, and it's a liability: nothing forces someone to remember to
disable a leaver's account on every tool individually, and several of these
tools hold client credentials. This project exists to fix that by making
login one thing, once, everywhere.

It is not a general-purpose IdP product, not a replacement for O365/Entra,
and not trying to support external or non-employee identities. It's a thin,
purpose-built bridge between "the identity the org already pays for" and
"a login system that a Node/Python/PHP internal tool can trust."

## 2. Scope

**In scope:** every custom-built internal tool the org runs — currently at
least CDMS, plus other internal tools across Node, Python, and PHP stacks.
All of these are slated to sit behind this login, per an explicit decision
to lock down all custom software behind a real auth system, not just a
firewall.

**Out of scope (for now):** ERPNext. It already manages its own user
accounts and is low priority to fold in. Don't spend early design effort
accommodating it — revisit later if it becomes worth the integration cost.

**Explicitly not a goal:** supporting external users, clients, or
contractors. There is no client portal and no contractor access requirement
today. If that changes, it changes the calculus on self-hosted IdP
(Keycloak/Authentik) vs. what's being built here — see §3.

## 3. Architecture decision: Entra ID (O365) via OIDC

Four options were considered:

1. **Keep local per-app accounts** (status quo, e.g. CDMS today) — rejected.
   Doesn't solve the deprovisioning problem; it's the exact thing this
   project exists to replace.
2. **Vaultwarden (self-hosted)** — rejected. It's a credential vault, not an
   identity provider — it authenticates *outward* as a client, but it has no
   OIDC/SAML issuer that other apps can authenticate *against*. Wrong shape
   for this problem entirely.
3. **Self-hosted IdP (Keycloak/Authentik)** — shelved. Would work, but there's
   no requirement pulling toward it: no external identities to manage, no
   need for federation beyond what O365 already offers, and it's new
   infrastructure to stand up and maintain for no clear benefit over option 4.
4. **Entra ID (O365) via OIDC** — **chosen.** The org already pays for and
   manages O365 identities. Reusing them means deprovisioning one account
   revokes access everywhere, with no new infrastructure to run. It may also
   add MFA "for free" if Conditional Access policies apply — see the open
   question in §6.

This is a case of using the identity the org already has, rather than
building or hosting a new one. No multi-IdP abstraction is planned; if a
second IdP is ever genuinely needed, that's a deliberate future decision,
not something to speculatively design in now.

## 4. Technical shape

None of this is built yet. This is the agreed direction, described at a
level a task breakdown can be written against.

**Identity flow.** BTAuthOrchestrator registers as a single application in
Entra and acts as the OIDC relying party. Users authenticate against Entra
(interactively, via the standard authorization code flow); BTAuthOrchestrator
receives the result and is the only thing that mints session tokens for the
org's tools. It does not proxy every request afterward — see below.

**Token signing: asymmetric (RS256 or ES256), not shared-secret.**
This is the one piece of CDMS's existing design that does *not* carry over
as-is. CDMS uses a single HS256 secret to both sign and verify — fine for
one app, but wrong here: with mixed stacks (Node, Python, PHP) across
multiple apps, a shared secret means any one app leaking it lets an attacker
forge tokens for *every* app. Instead, BTAuthOrchestrator holds the private
signing key and is the only party that ever signs a token. Every consuming
app receives only the public key and does verification-only. This is
supported natively in every language in play — `jose` in Node, PyJWT in
Python, firebase/php-jwt in PHP — so no app needs a custom crypto
implementation, just a standard library and a public key.

**Session cookie scoped to the parent domain.** The other tools run on the
same server or on subdomains of one parent domain as CDMS, so a cookie set
with `Domain=.company.local` (adjust to the real domain) is visible to all
of them without a per-app redirect handshake. This is a meaningful
simplification versus a fully decoupled multi-domain SSO flow — worth
keeping as a hard constraint on deployment topology (all consuming apps stay
under one parent domain) rather than something to generalize away.

**Verification stays local to each app.** CDMS's `src/proxy.ts` is the
template: it verifies a JWT on every request via `jose`, with zero opinion
about how the token was minted, plus a `PUBLIC_PATHS` allowlist and a
`DISABLE_AUTH` escape hatch for local dev. Every consuming app should have
an equivalent thin middleware for its own stack. This matters for two
reasons: it keeps request-path latency independent of BTAuthOrchestrator
being reachable, and it means BTAuthOrchestrator is only a hard runtime
dependency at login time and token-refresh time — not on every request of
every app. If BTAuthOrchestrator itself is briefly down, already-issued
tokens keep working until they expire.

**No TLS assumption.** These tools run on plain internal HTTP, behind a
corporate firewall, with no TLS anywhere in the org's current setup. CDMS
just hit this directly today: its login cookie was hardcoded to
`secure: NODE_ENV === "production"`, which silently broke login because
production builds set `NODE_ENV=production` regardless of whether TLS is
present — the browser then refused to send the Secure cookie over plain
HTTP. Fixed there with an explicit `COOKIE_SECURE` env var, default false.
BTAuthOrchestrator and every consuming app's cookie/token logic need to make
the same assumption from day one: do not derive "are we secure" from
`NODE_ENV`, use an explicit, defaulted-to-false flag.

**Break-glass admin persists as a permanent pattern, not a CDMS-only hack.**
Any real SSO deployment needs an out-of-band admin path, because the IdP
itself is a single point of failure — tenant outage, a misconfigured app
registration, a network egress problem, anything. CDMS already has this
(`.env`-configured `FALLBACK_ADMIN_USERNAME`/`PASSWORD`, always works even if
the primary auth path or DB is down) and it's explicitly meant to survive
this migration, not be deleted once Entra is wired up. **Decided
(2026-09-15, see ADR-002): each app keeps its own break-glass path, built
entirely internally as its own auth override.** BTAuthOrchestrator has no
central break-glass path, no visibility into any app's break-glass design,
and is never asked what an app's mechanism is — the same reason
verification stays local: a central break-glass mechanism would itself be a
single point of failure for the exact outage scenario it exists to cover.

## 5. What's resolved vs. still open

**Resolved (treat as constraints, not open questions):**
- Target IdP is Entra ID via OIDC. Not multi-IdP, not self-hosted.
- All consuming apps are custom-built and under the org's control — no
  vendor/off-the-shelf app needing special SSO-tier handling.
- No external or non-employee identity requirement — this is what ruled out
  a self-hosted IdP; revisit that decision if this constraint ever changes.
- All consuming apps sit on one server or one parent domain's subdomains —
  enables a single domain-scoped session cookie.
- Signing must be asymmetric (RS256/ES256), not a shared HS256 secret,
  because of mixed stacks across apps.
- BTAuthOrchestrator's own OIDC-facing endpoints (login redirect and
  callback) require TLS — Entra rejects non-HTTPS redirect URIs, confirmed
  during Entra app registration for `orca.biztechro.com`
  (`tasks/completed/TASK-001-entra-app-registration.md`). This does not
  extend to consuming apps, which remain on plain internal HTTP for now,
  and it does not change the session cookie's `Secure` flag default:
  `COOKIE_SECURE` stays false, governed by whether all consuming apps have
  TLS (they don't), not by the orchestrator's own TLS status. Cert strategy:
  split-horizon DNS against `biztechro.com` (Cloudflare, DNS-01) with Caddy
  terminating TLS in front of the Node process.
- MFA/Conditional Access: confirmed during Entra app registration that
  Security Defaults are not enabled on this tenant — no MFA or Conditional
  Access currently applies to any sign-in, including this app.
  BTAuthOrchestrator is the first thing to actually exercise O365 as an app
  IdP, and today that happens with no MFA uplift. Enabling Security Defaults
  is a tenant-wide switch affecting all of O365, not scoped to this app —
  out of scope for this project; a separate IT security-posture decision if
  Patrick chooses to pursue it later.
- Centralized vs. per-app break-glass admin (see §4): each app keeps its
  own, built entirely internally. BTAuthOrchestrator has no central
  break-glass path and no role in any app's. Decided 2026-09-15, see
  ADR-002.

**Open:**
- None outstanding as of 2026-09-15.

## 6. Rough first milestone

Sequenced to prove the riskiest, least-understood piece first (Entra as an
app IdP, given it's never been used that way) and to integrate against the
app that already has the closest-matching pattern before touching the
Python/PHP tools.

1. **Entra app registration.** Register BTAuthOrchestrator as an application
   in Entra; confirm redirect URIs, scopes, and — per the open question above
   — what MFA/Conditional Access actually applies once a custom app is in
   the loop.
2. **Minimal OIDC login flow + token issuance.** Authorization code flow
   against Entra, then mint an RS256/ES256-signed session token on success.
   No UI polish, no multi-tenant concerns — just prove the mint end works
   and that a token can be verified offline with only the public key.
3. **First consuming app integration: CDMS.** Replace or sit alongside
   CDMS's local login, adapting `src/proxy.ts` to verify orchestrator-issued
   tokens instead of (or in addition to, during transition) its own HS256
   tokens. Chosen first because the verification pattern already exists
   there and only needs to change algorithms/key source, not be invented.
   Keep CDMS's break-glass admin working throughout — it must not regress
   during this migration.
4. **Second consuming app integration: one non-Node tool.** Pick whichever
   Python or PHP tool is simplest, and write its verification middleware
   from scratch using PyJWT or firebase/php-jwt. This is the real test of
   whether the "verification-only, per-language, public key" design holds up
   outside Node/jose.
5. **Rollout to remaining tools**, once the pattern has been proven twice
   across at least two different stacks.

Not in this milestone: admin UI for user/session management, audit logging,
token refresh strategy details, and the centralized-vs-per-app break-glass
decision — all worth their own design pass once the core flow is proven.
