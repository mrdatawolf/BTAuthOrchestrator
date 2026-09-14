# Development Guide

## Technology stack

- Node.js with TypeScript.
- Node.js's built-in HTTP server and environment-file support.
- PGlite (`@electric-sql/pglite`) for the embedded PostgreSQL-compatible data
  store.
- `jose` for RS256 JWT signing and public-key/JWK conversion.

## Repository layout

- `src/`: service source code, including bootstrap configuration and the HTTP
  entry point.
- `scripts/seed.js`: stable bootstrap entry point that loads the compiled seed
  implementation from `dist/seed.js`.
- `dist/`: compiled JavaScript output created by the build (not committed).
- `docs/`: project documentation, contracts, decisions, and workflow guidance.
- `tasks/`: lifecycle-managed task records.

## Setup and commands

Copy `.env.example` to `.env` and replace its example values as appropriate.
All seven listed variables must be non-empty, and `PORT` must be an integer from
1 through 65535.

`SERVICE_ISSUER` sets the session-token `iss` claim. Production must use
`https://orca.biztechro.com`; non-production deployments may use their own
canonical issuer value.

```sh
npm install
npm run dev
npm run build
npm run seed
npm start
```

`npm run dev` builds/type-checks and starts the service. `npm run build` compiles
and type-checks it into `dist/`, and `npm start` runs the compiled service.
The health check is available at `GET /health`. Public signing keys are
available at `GET /.well-known/jwks.json`; this response includes current and
retired keys, excludes revoked keys, and uses `Cache-Control: no-store`.

The OIDC login flow (CONTRACT-001) is implemented at `GET /auth/login`
(redirects to Entra with a freshly generated, single-use `state`/`nonce`/PKCE
`code_verifier`, held in an in-memory, 10-minute-TTL handshake store) and
`GET /auth/callback` (Entra's registered redirect URI; exchanges the
authorization code, validates the ID token against Entra's own cached
discovery document and JWKS, and on success mints and sets the `bt_session`
cookie via `src/tokens.ts`). Entra's discovery document is fetched lazily on
first use and cached in memory (a transient refetch failure falls back to the
last-known-good document rather than failing a login); Entra's JWKS is cached
by `jose`'s own remote-JWKS-set logic. `CLIENT_SECRET` is read via
`SecretsStore.getSecret("CLIENT_SECRET")` at each callback, never from `.env`.
Failure responses follow CONTRACT-001's fixed status-code tiers (502 for an
unreachable Entra, 400 for an invalid/expired handshake or a rejected/invalid
token exchange, 500 for a missing identity claim or other unexpected error)
and are always plain HTML with a generic, non-technical message.

After configuring `.env` and building, bootstrap a fresh database with the
normative command `node scripts/seed.js`. The launcher starts the compiled
implementation with Node's `--env-file=.env` support. It prompts for
`CLIENT_SECRET` without echoing input and generates the initial RS256 signing
key. For non-interactive setup, use
`node scripts/seed.js --client-secret-file=<path>`; the input
file is deleted immediately after it is read and before the database is opened.
Never pass the secret itself on the command line. `npm run seed` is a convenience
alias that builds first and then runs the same entry point.

On startup, the service creates `PGLITE_DATA_DIR` with mode `0700` when it is
absent, verifies an existing directory is mode `0700` and owned by the running
user, acquires a single-process lock, opens PGlite, and applies the idempotent
schema migration before listening. Existing directories with different mode or
ownership are rejected with a corrective `chmod` or `chown` message; the service
does not modify their permissions or ownership automatically. A lock left after
an unclean process termination must be removed manually after confirming no
other service process is using the directory.

## Coding conventions

- Use TypeScript with strict type checking and ES module-compatible imports.
- Use camel case for variables and functions, Pascal case for interfaces, and
  uppercase snake case for environment variable names.
- Keep bootstrap configuration validation separate from HTTP route setup.

## Testing philosophy

Document required test levels, coverage expectations, fixtures, and manual checks.

## Security and privacy

Document secrets handling, data classification, dependency, and reporting rules.
