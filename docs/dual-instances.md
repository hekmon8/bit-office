# Public demo and private office

Both instances use this repository and the same frontend assets. Their entrypoints enforce different roles on the server; a URL, client request or mis-set environment role cannot select the other instance.

| Instance | UI | MCP | Bindings |
| --- | --- | --- | --- |
| `src/demo-worker.ts` | Labelled synthetic sample data, browser-only simulation | Five read-only synthetic tools, no private credential accepted | `ASSETS` only; private bindings are discarded even if supplied accidentally |
| `src/private-worker.ts` | Operator login, then a read-only managed-office viewer | Fixed Bearer or the existing PR6 OAuth flow; eight tools after authorization | Its own `OFFICE`, management secret, canonical `OAUTH_ISSUER`, and optional isolated `OAUTH_KV` for OAuth |

The PR6 compatibility entry `src/worker.ts` shows demo data while its authenticated MCP manages records. The deployable `wrangler.jsonc` now selects `src/private-worker.ts`; its only configuration change is that entrypoint. Deploying it makes the existing canonical website login-gated and reads the existing managed records. The code/configuration commit alone does not activate this change. The separate `wrangler.demo.jsonc` selects a new stateless `bit-office-demo` Worker with only `ASSETS`, no private data bindings, credentials, migrations or custom domain.

## Safe configuration handoff

`wrangler.demo.example.jsonc` and `wrangler.private.example.jsonc` are inert starting templates: `workers_dev` is false and routes are empty. Neither invents a domain, includes a secret, nor copies an OAuth KV ID. Do not publish them unchanged or infer permission from the presence of a template. Approve the exact Worker names, public/private URLs, bindings and account quota/cost impact before provisioning or promotion. Never enable an unchosen public hostname for the private instance.

The prepared activation retains the original `bit-office` Worker, existing `OFFICE` class/namespace and migration history, production OAuth KV, canonical issuer, routes and secrets. No records or tokens are transferred. The existing `bit-office-staging` environment keeps its separate OAuth KV and Office namespace and its empty route list; deploy it with `--env staging`. Public-demo activation uses `npx wrangler deploy --config wrangler.demo.jsonc` only after approval of the new Worker/URL and quota impact. Do not copy credentials between Workers or delete the old deployment.

For the private instance, safely configure `OFFICE_MCP_TOKEN` and its exact HTTPS `OAUTH_ISSUER`. The management secret must be 32–4096 non-whitespace characters, independent from adapter/upstream secrets and from other instances. Store it only through an approved secret store or the user's secure local handoff. Never put it in this repository, a URL, Vite variables, browser storage, logs or chat. The browser presents the login form on the configured origin; aliases cannot establish or replay its viewer session. Configure `OAUTH_KV` with the private instance's own namespace to activate the existing OAuth protocol. An absent KV leaves OAuth unavailable but does not disable the fixed-Token managed API or configured viewer.

Do not put an interactive whole-site Cloudflare Access page in front of OAuth discovery, `/oauth/register`, `/oauth/token`, `/oauth/authorize` or `/mcp` / `/mcp/oauth`. The app protects its UI and viewer API separately. Any additional Access policy must preserve the protocol endpoints and requires approval of its exact scope. Actual ChatGPT connection and OAuth consent remain owner actions; this implementation does not create a real grant.

## Private viewer

`GET /api/instance` identifies the frontend mode without returning office data. In private mode, UI documents show the operator login until authenticated; `/api/demo/state` is unavailable. The frontend reads `GET /api/viewer/state` using a host-only, Secure, HttpOnly, SameSite=Lax cookie. A viewer session never substitutes for an MCP access token and cannot create/update Agent records. The private UI removes demo activity, room expansion and synthetic resets. It preserves pan/zoom, tasks, handoffs and separate read, task-report and heartbeat timestamps.

The office is `source: managed`, `stateAuthority: client_reports`, `runtimeConnected: false`. Creating an Agent registers a record, not a process. Missing heartbeat displays as unreported; stale or incomplete task reads stay unknown rather than idle. Private read errors keep an explicitly marked old private snapshot, and initial read failure never substitutes synthetic samples. Unauthorized reads clear the scene and return to login. Private documents/data use `Cache-Control: no-store`; private pages clear their view before history suspension and reload on a restored history entry.

The viewer uses 30-day fixed-lifetime random sessions with server-side hashes, origin/credential fingerprints, replacement on login and immediate logout revocation. Its auth-only keys share the existing OfficeStore SQLite Durable Object and are excluded from office snapshots. No new database class, migration, D1 or R2 is introduced. KV remains dedicated to the existing OAuth provider: it is [eventually consistent](https://developers.cloudflare.com/kv/concepts/how-kv-works/), so viewer logout checks use [Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) rather than a cached KV revocation entry. The browser cookie and server session share the same lifetime. Lax cookies allow returning through a link from another site; login and logout still require a same-origin POST. Existing sessions retain their original expiry until the next login. Login attempts and session counts are bounded. Rotating the management secret invalidates viewer sessions and the existing OAuth credential fingerprints.

## Verification and release order

1. Reconcile the latest `main` before review and promotion. OAuth diagnostics in PR8 are a separate change; successful DCR connection does not imply the original CIMD fetch failure is repaired.
2. Run `npm run check`, plus browser login/read/logout checks using only disposable local credentials and records. Verify strict-demo isolation even when private bindings are accidentally supplied.
3. Review the exact current head. Keep the original worktree, deployments, secrets and data intact.
4. With approval of the exact configuration/instance impact, select the current PR branch on the existing staging build trigger while preserving `npm run check` and `npx wrangler deploy --env staging`. Run the existing PR → isolated staging → merge → native build → production verification flow. Verify the stateless public demo before changing the existing website to private. Staging must have separate Office/OAuth bindings, issuer and credentials. Never place production runtime secrets into PR builds.
5. Confirm the exact public/private origin and complete the owner credential/authorization handoff before activating a new private deployment. Verify anonymous denial, login, read-only viewer, Cookie/MCP separation, logout replay denial, and real OAuth discovery/PKCE independently from UI login. Do not call browser emulation a physical iPhone test.

There is no model API client or runtime executor in the public demo. It cannot call paid models, execute real tasks, read the managed store or proxy the private upstream. Infrastructure usage still follows the Cloudflare account plan; this code does not create a paid subscription or promise unlimited free traffic.
