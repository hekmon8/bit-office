# Public demo and private office

Both instances use this repository and the same frontend assets. Their entrypoints enforce different roles on the server; a URL, client request or mis-set environment role cannot select the other instance.

| Instance | UI | MCP | Bindings |
| --- | --- | --- | --- |
| `src/demo-worker.ts` | Labelled synthetic sample data, browser-only simulation | Five read-only synthetic tools, no private credential accepted | `ASSETS` only; private bindings are discarded even if supplied accidentally |
| `src/private-worker.ts` | Operator login, then a read-only managed-office viewer | Fixed Bearer or the existing PR6 OAuth flow; eight tools after authorization | Its own `OFFICE`, management secret, canonical `OAUTH_ISSUER`, and optional isolated `OAUTH_KV` for OAuth |

The existing `src/worker.ts` and `wrangler.jsonc` remain the PR6 compatibility deployment: its website shows demo data and its authenticated MCP manages records. They are not the strict public-demo deployment. This change does not switch, rename, delete or redeploy that existing instance.

## Safe configuration handoff

`wrangler.demo.example.jsonc` and `wrangler.private.example.jsonc` are inert starting templates: `workers_dev` is false and routes are empty. Neither invents a domain, includes a secret, nor copies an OAuth KV ID. Do not publish them unchanged or infer permission from the presence of a template. Approve the exact Worker names, public/private URLs, bindings and account quota/cost impact before provisioning or promotion. Never enable an unchosen public hostname for the private instance.

To retain existing Agent records, the owner may choose to keep the original Worker name, `OFFICE` namespace and migration history, then switch its entrypoint to `src/private-worker.ts`. Copy the chosen existing configuration into `wrangler.private.local.jsonc` at the repository root (Git-ignored); keep its bindings intact. Create a separate stateless demo Worker with `src/demo-worker.ts`. This retains the existing office and avoids automatic record/token migration. Alternatively, a fresh private Worker starts with an empty, isolated OfficeStore; transferring records requires a separately approved migration. Do not copy credentials between Workers or delete the old deployment.

For the private instance, safely configure `OFFICE_MCP_TOKEN` and its exact HTTPS `OAUTH_ISSUER`. The management secret must be 32–4096 non-whitespace characters, independent from adapter/upstream secrets and from other instances. Store it only through an approved secret store or the user's secure local handoff. Never put it in this repository, a URL, Vite variables, browser storage, logs or chat. The browser presents the login form on the configured origin; aliases cannot establish or replay its viewer session. Configure `OAUTH_KV` with the private instance's own namespace to activate the existing OAuth protocol. An absent KV leaves OAuth unavailable but does not disable the fixed-Token managed API or configured viewer.

Do not put an interactive whole-site Cloudflare Access page in front of OAuth discovery, `/oauth/register`, `/oauth/token`, `/oauth/authorize` or `/mcp` / `/mcp/oauth`. The app protects its UI and viewer API separately. Any additional Access policy must preserve the protocol endpoints and requires approval of its exact scope. Actual ChatGPT connection and OAuth consent remain owner actions; this implementation does not create a real grant.

## Private viewer

`GET /api/instance` identifies the frontend mode without returning office data. In private mode, UI documents show the operator login until authenticated; `/api/demo/state` is unavailable. The frontend reads `GET /api/viewer/state` using a host-only, Secure, HttpOnly, SameSite=Strict cookie. A viewer session never substitutes for an MCP access token and cannot create/update Agent records. The private UI removes demo activity, room expansion and synthetic resets. It preserves pan/zoom, tasks, handoffs and separate read, task-report and heartbeat timestamps.

The office is `source: managed`, `stateAuthority: client_reports`, `runtimeConnected: false`. Creating an Agent registers a record, not a process. Missing heartbeat displays as unreported; stale or incomplete task reads stay unknown rather than idle. Private read errors keep an explicitly marked old private snapshot, and initial read failure never substitutes synthetic samples. Unauthorized reads clear the scene and return to login. Private documents/data use `Cache-Control: no-store`; private pages clear their view before history suspension and reload on a restored history entry.

The viewer uses 30-minute random sessions with server-side hashes, origin/credential fingerprints, replacement on login and immediate logout revocation. Its auth-only keys share the existing OfficeStore SQLite Durable Object and are excluded from office snapshots. No new database class, migration, D1 or R2 is introduced. KV remains dedicated to the existing OAuth provider: it is [eventually consistent](https://developers.cloudflare.com/kv/concepts/how-kv-works/), so viewer logout checks use [Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) rather than a cached KV revocation entry. Login attempts and session counts are bounded. Rotating the management secret invalidates viewer sessions and the existing OAuth credential fingerprints.

## Verification and release order

1. Finish/reconcile PR6 first; this change is stacked on its exact reviewed head.
2. Run `npm run check`, plus browser login/read/logout checks using only disposable local credentials and records. Verify strict-demo isolation even when private bindings are accidentally supplied.
3. Review the exact current head. Keep the original worktree, deployments, secrets and data intact.
4. With an approved configuration, run the existing PR → isolated staging → merge → native build → production verification flow. Staging must have separate Office/OAuth bindings, issuer and credentials. Never place production runtime secrets into PR builds.
5. Confirm the exact public/private origin and complete the owner credential/authorization handoff before activating a new private deployment. Verify anonymous denial, login, read-only viewer, Cookie/MCP separation, logout replay denial, and real OAuth discovery/PKCE independently from UI login. Do not call browser emulation a physical iPhone test.

There is no model API client or runtime executor in the public demo. It cannot call paid models, execute real tasks, read the managed store or proxy the private upstream. Infrastructure usage still follows the Cloudflare account plan; this code does not create a paid subscription or promise unlimited free traffic.
