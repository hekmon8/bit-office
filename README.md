# Bit 小屋 · Bit Office

An original pixel-pet office floor plan, deployed on Cloudflare Workers with a **Streamable HTTP MCP** endpoint for public demo reads and authenticated Agent management.

Personal office after activation: https://agents.hekmon.com

Public demo after separate deployment: https://bit-office-demo.macros-hekk.workers.dev

The deployable `wrangler.jsonc` now selects the private read-only viewer and retains
the existing Worker identity, Office data and OAuth bindings. `wrangler.demo.jsonc`
selects a separate stateless public demo with assets only. These are deployment
targets, not a claim that either activation has already occurred. See the
[dual-instance guide](docs/dual-instances.md) for approval, staging and rollout.
The original Workers.dev alias cannot establish a private viewer session; use the
canonical personal-office origin above.

## What runs here

- Top-down office: meeting rooms, discussion room, desks, kitchen, fishing pond, charging nests — one personal area and one company area for connected coding sessions.
- Space-first desktop and mobile map with pan, zoom and pet / occupied-desk task details. The floor is split into named areas (personal / company), drawn as dashed bands that can be clicked, plus a zone switcher that fits one area to the viewport (`docs/images/zone-bands.png`). Room lists, status, settings and MCP instructions open in dismissible dialogs with back navigation and focus restoration.
- Browser-only demo activity changes and bounded meeting-room expansion.
- Five public read-only MCP tools returning **synthetic sample data only**.
- Three authenticated Agent-management tools with persistent server storage and revision checks.
- An optional server-side MCP client and a protected office-state adapter, configured with a URL, authentication type and server-stored token.
- Separate execution counts, connectivity, task handoff evidence and observation timestamps. The compact source badge remains visible; successful reads expire after two minutes and offline fallback is explicit.

The public demo is stateless. Browser simulation is private to the current page and resets on reload; it does not update the MCP snapshot. No real Multica workspace, agent, task, credential or execution runtime is configured by default. All members and events are illustrative. “Meeting”, “resting” and “fishing” are demo animations, not inferred from runtime idleness.

## Local development

Requires Node 22.12+ and npm.

```sh
npm ci
npm run check
npm run build
npx wrangler dev --config wrangler.demo.jsonc
```

Open http://localhost:8787 for the local synthetic demo. For UI hot reload, keep the Worker running and run `npm run dev` in another terminal. Vite proxies the demo API and MCP to the local Worker. `npm run dev:worker` instead starts the configured private entry; follow the dual-instance guide for disposable local credentials and its canonical origin.

## ChatGPT / MCP

Public demo endpoint after deployment: `https://bit-office-demo.macros-hekk.workers.dev/mcp`.

Personal management endpoint: `https://agents.hekmon.com/mcp/oauth`, using OAuth. It manages persistent reported records; the separately authenticated website is a read-only viewer. Private MCP rejects anonymous requests.

The public demo does not require authentication because it exposes no private data. Configure a remote MCP app with the Streamable HTTP endpoint and “no authentication”, if your ChatGPT account / workspace permits it. Scan tools, then read the synthetic office state. Actual ChatGPT connection must be tested separately; a local MCP test is not that verification.

| Tool | Purpose |
| --- | --- |
| `get_office_state` | Synthetic agents, rooms and independent execution counts |
| `get_agent_state` | One demo agent, tasks, connectivity and timestamps |
| `list_rooms` | Demo room occupancy |
| `get_task_handoff` | Explicit synthetic delegation, not retry parent IDs |
| `get_connection_info` | Data provenance and unconnected integrations |

Anonymous access has no write tools. `GET /api/demo/state` and anonymous `/mcp` requests always serve the synthetic source. Authenticated management tools are described below; they operate on separate persistent records. The protected `/api/live/*` adapter requires explicit server configuration and a separate read credential; it never changes the public demo.

## Server-side MCP connection

The first adapter supports remote **Streamable HTTP** servers with `none`, `bearer` or `api_key` authentication. It uses the official MCP client SDK for initialization, tool discovery, negotiated protocol headers and session cleanup. OAuth login/refresh and legacy SSE-only/stdio servers are not implemented.

Configuration is read only from the Worker environment; there is no web endpoint for saving credentials or selecting a request-supplied upstream URL. The browser continues to show the public demo. The authenticated adapter API is the data integration seam for a future private viewer.

| Variable | Meaning |
| --- | --- |
| `UPSTREAM_MCP_URL` | Public HTTPS MCP endpoint; no credentials, query parameters, fragments or non-443 port |
| `UPSTREAM_MCP_AUTH` | Required: `none`, `bearer`, or `api_key` |
| `UPSTREAM_MCP_TOKEN` | Required for Bearer/API Key; leave unset for `none` |
| `UPSTREAM_MCP_API_KEY_HEADER` | Optional `X-…` header, default `X-API-Key`; routing/cookie headers are disallowed |
| `UPSTREAM_MCP_STATE_TOOL` | Optional read tool name, default `get_office_state` |
| `LIVE_READ_TOKEN` | Independent adapter read token, at least 32 non-whitespace characters; must differ from the upstream token |

Bearer authentication sends `Authorization: Bearer <UPSTREAM_MCP_TOKEN>`. API-key authentication sends the configured header on every upstream request. Tokens are never accepted in URLs or forwarded from the incoming request. Redirects are rejected; credentials stay on the configured endpoint. Only trusted operator configuration can choose a destination; hostname checks are not DNS pinning, so do not configure untrusted hostnames/DNS. Use a scoped upstream read credential: MCP tool annotations are advisory, not an upstream permission system.

For local configuration, copy the non-secret template and fill it using an editor:

```sh
cp .env.example .dev.vars
chmod 600 .dev.vars
```

`.dev.vars` is Git-ignored. Keep the credential's recoverable local copy there before installing production secrets. Install the completed file into the intended Worker using `npx wrangler secret bulk .dev.vars --env ""` only when production configuration is authorized; do not put secrets into `wrangler.jsonc`, Vite variables, browser storage or Git. Staging uses its own `.dev.vars.staging` and secrets (`--env staging`); production credentials are not inherited. No secret is generated or uploaded by application code.

Protected API, authenticated with `Authorization: Bearer <LIVE_READ_TOKEN>`:

- `GET /api/live/connection`: redacted configuration metadata. `connectionVerified: false` means this endpoint has not contacted the upstream.
- `GET /api/live/state`: connect, discover the configured tool, call it with `{}`, validate/project its office snapshot and return execution counts. Only a discovered tool with `readOnlyHint: true` may be called. Other tools are never exposed or invoked.

Unconfigured access returns `503`; missing/wrong read credentials return `401`; mutations return `405`. Connection/authentication errors and invalid snapshots return redacted `502` errors, and a stalled read returns `504`. Reads have a 10-second overall deadline plus at most one second for best-effort session cleanup, bounded tool pagination and a 1 MiB response limit per HTTP response. No snapshots, clients or credentials are cached across requests. Responses use `Cache-Control: no-store`.

### Office snapshot contract

MCP is a transport, not a common office-data schema. The selected tool must accept empty arguments and return this contract in `structuredContent` or one JSON text block. A service with different tools or payloads needs a service-specific adapter rather than automatic field guessing.

- `mode`: `live` with `source: "mcp"` or `"managed"`, or `demo` with `source: "synthetic"`. Synthetic sources stay synthetic after connection.
- `observedAt`: the source's ISO timestamp; not replaced by the adapter's read time.
- `rooms`: `{ id, name, kind, topic, capacity, x, y, w, h, zone, columns? }`, using the existing activity names (`working`, `meeting`, `discussing`, `resting`, `fishing`, `offline`). `zone` names the area the room belongs to; `columns` overrides the pet grid when a room is unusually wide.
- `zones`: `{ id, name, description, originY }[]`; rooms and agents must agree on their zone.
- `agents`: `{ id, name, color, activity, roomId, zone, online, lastSeenAt, tasks, tasksComplete?, parentId?, depth?, retiredAt?, retireReason?, revision?, updatedAt?, tasksObservedAt? }`. `lastSeenAt` may be `null`; missing `tasksComplete` defaults to `false`, so an empty task list is unknown rather than idle. `parentId`/`depth` express delegation, `retiredAt` marks a soft-retired record outside the active capacity count.
- `tasks`: `{ id, title, status, blocked?, delegatedFrom?, handoffNote?, updatedAt?, handoffAt? }`, using the task statuses in `src/model.ts`.
- `events`: `{ at, message }[]`.

IDs must be unique and contain only letters, digits, `_` or `-`; room references and capacity must be valid. Invalid timestamps, unsafe colors, contradictory provenance and out-of-bounds collections/geometry are rejected. Only known fields are returned, not upstream metadata or credential fields. The adapter adds `lastSuccessfulReadAt`, `snapshotFresh` (source observation no older than two minutes and not in the future), and each agent's `execution`. Task-event, heartbeat, source-observation and successful-read timestamps stay distinct.

## Real data boundary

Use an upstream credential issued for the intended MCP service, workspace and read scopes. The upstream service remains responsible for validating its token issuer, audience, expiry and workspace membership. The adapter uses a separate operator-managed read token for its single configured source; it does not provide multi-user or workspace authorization. Do not copy browser cookies or private source code into this project. Do not forward one resource's token to a different audience. Store secrets only in an approved secret store; never in this repository.

Online is independent of running. Running and queued tasks can coexist. A blocked issue is evidence for its task, not evidence that all execution stopped. Incomplete or stale task reads yield unknown rather than idle. Last successful read, task event and heartbeat times must remain distinct.

## Persistent Agent management tools

The same `/mcp` endpoint selects the managed office when the client sends
`Authorization: Bearer <OFFICE_MCP_TOKEN>`. Configure the independent token
only in server secrets; it must be 32–4096 non-whitespace characters and differ
from both upstream and adapter-read tokens. Clients need the management token
in their MCP request headers. Tokens are never persisted in Agent records or
browser storage. An incorrect supplied token returns 401; missing server
configuration returns 503. Anonymous requests retain the five public demo tools
and cannot read or mutate the managed office. This is one operator-managed
office, not per-user or per-workspace access control. Any holder of the management
token can read and update all managed records.

Authenticated clients see the original five read tools, now reading the managed
store, plus these four write tools:

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `create_agent` | `agent_id`, `name`; optional `color`, `activity`, `room_id`, `zone_id`, `parent_id` | Registers a persistent record; duplicate IDs fail without overwriting. Defaults to offline, in an available offline room of the parent's zone (or the personal zone), with no heartbeat or tasks. `parent_id` links a delegated child and is depth-limited. |
| `update_agent` | `agent_id`, `expected_revision`; `name` and/or `color` | Updates profile fields and increments the Agent revision. |
| `update_agent_status` | `agent_id`, `expected_revision`; optional `activity`, `room_id`, `zone_id`, `online`, `heartbeat`, `tasks`, `tasks_complete` | Reports status and optionally replaces the Agent's task list. |
| `retire_agent` | `agent_id`, `expected_revision`; optional `reason`, `cascade` | Soft-retires the record: history stays readable through `get_agent_state`, but the record releases its room slot and stops counting toward the active-agent limit. `cascade` (default true) retires delegated children too. |

### Zones, lineage and retirement

The floor is split into named areas (`zones`). Room assignment is keyed by
`(zone, activity)`, so a company session never shares a room with a personal
record; `list_rooms` and `get_office_state` both return `zones`. A delegated
child carries `parentId`/`depth` (chain limit 3) and is drawn as a child of the
session that spawned it. `get_office_state` omits retired records unless
`include_retired` is set, and always reports `retiredCount`. Retiring the parent
of a child also retires the child, because a child cannot outlive its session.

Read `get_agent_state` first and send `agent.revision` as `expected_revision`.
A concurrent update returns `revision_conflict`; read again before retrying.
`agent_limit`, `agent_retired`, `depth_limit`, `parent_not_found` and
`parent_retired` describe the remaining refusal cases. `OFFICE_MAX_AGENTS`
(default 300), `OFFICE_MAX_RECORDS` (default 400) and `OFFICE_MAX_DEPTH`
(default 3) tune the budgets; once the record budget is exceeded the oldest
retired records are pruned first.

### OAuth and Bearer Token clients

Both authentication methods access the same single operator-managed office.
For clients that accept custom request headers, keep using `/mcp` with
`Authorization: Bearer <OFFICE_MCP_TOKEN>`. Anonymous `/mcp` remains the public
five-tool demo; a supplied invalid credential never falls back to demo.

For ChatGPT, add `https://agents.hekmon.com/mcp/oauth` and select **OAuth**.
Use automatic discovery and either CIMD or dynamic client registration; no
manually entered client secret is needed. The server advertises protected
resource metadata at `/.well-known/oauth-protected-resource/mcp/oauth` (with a root
alias) and authorization-server metadata at `/.well-known/oauth-authorization-server`.
When the authorization page opens on this site's origin, enter the management
Token and approve access. It verifies the Token server-side and issues a separate
OAuth credential to the client. Do not put the management Token in a URL,
OAuth Client Secret field, or client registration metadata.

The Cloudflare OAuth provider handles authorization code + S256 PKCE, CIMD,
dynamic registration, browser-bound single-use consent, one-hour access tokens,
30-day refresh grants and rotating refresh tokens. Revocation uses the advertised
`revocation_endpoint` (the token endpoint), with `token` and `client_id` form fields.
The `office:manage` scope permits all eight tools. The authorization page always
asks for consent, shows the client and callback host, and never remembers the
management Token in application browser storage. OAuth grants contain a hashed
credential fingerprint rather than the management Token; rotating the management
Token invalidates existing OAuth access and requires authorization again.

Deployments require `OAUTH_KV` and a canonical HTTPS origin in `OAUTH_ISSUER`.
Production and staging use separate KV namespaces, Durable Objects, issuers and
management Tokens. `global_fetch_strictly_public` is required for CIMD SSRF
protection. Configure staging's Token separately from production; never copy
production `.dev.vars` into a staging upload. This is operator authorization,
not a multi-user identity system, and creating an Agent still creates only a record.
For retrying creates, use the same `agent_id` and read the existing record after
`agent_exists`. Room assignment checks compatible activity and remaining
capacity within the same storage transaction. There are at most 100 Agent
records, 50 reported tasks per Agent, 100 recent events and a bounded snapshot.
Unknown fields and inconsistent task IDs/handoff references are rejected.
No delete, arbitrary execution or upstream write forwarding is provided.

Example tool arguments:

```json
{"agent_id":"builder","name":"Builder","activity":"working"}
```

```json
{"agent_id":"builder","expected_revision":1,"activity":"working","heartbeat":true,"tasks":[{"id":"build-1","title":"Build application","status":"running"}],"tasks_complete":true}
```

`heartbeat: true` records the server receipt time and reports online. Changing
profile, activity or `online` alone does not fabricate a heartbeat. Activity,
connectivity and task execution remain independent. Replacing tasks without
`tasks_complete` makes completeness unknown; omitting `tasks` preserves the
existing list and task-event timestamps. The server records `tasksObservedAt`
only for explicit task/completeness reports; heartbeats and profile changes do
not refresh it. Reports older than two minutes yield `tasksFresh: false` and an
unknown execution label, while retaining the reported counts. Offline activity cannot be combined
with an online/heartbeat report. Task states are client reports, not
provider-verified execution. Creating an Agent registers data and never starts
a Codex/Claude process. The compatibility deployment still displays its labelled demo; its private
managed records are exposed only through authenticated MCP. The dedicated private
entrypoint also displays those records through its authenticated read-only viewer;
see the dual-instance guide for its session and source boundaries.

Managed snapshots use `mode: "live"`, `source: "managed"`; connection information
reports `stateAuthority: "client_reports"` and `runtimeConnected: false`.
They are separate from the externally configured upstream MCP adapter. That
adapter can explicitly connect to a managed office using its read-only state
tool, but its upstream credential must differ from the caller's reader token.

Storage uses the `OFFICE` SQLite Durable Object and the additive
`v1-office-store` class migration. Staging has a separate Worker namespace and
must use its own token. The migration creates new storage; it does not import
synthetic agents or mutate existing upstream data. For local workerd checks,
configure a local `.dev.vars` token and run `npm run dev:worker`. Production
activation requires deployment of the new binding/class and a separately
authorized, recoverably stored management secret. No secret is generated or
uploaded by this feature.

## Deployment

```sh
npm run check
npm run deploy
```

Cloudflare account authentication must already exist. The strict public demo needs a Worker and static assets. Managed/private offices
use the existing SQLite Durable Object, and OAuth additionally uses its configured
KV namespace. Deployment must preserve the intended bindings and existing data;
this project does not create application credentials or paid subscriptions.

Workers Builds configuration:

- Repository: `hekmon8/bit-office`; deployment owner: `hekmon8`
- Production Worker: `bit-office`; production branch: `main`
- PR candidates: isolated `bit-office-staging` Worker, verified before promotion; deploy with `npx wrangler deploy --env staging` so production domain routes are excluded
- Root: `/`
- Build command: `npm run check`
- Deploy command: `npx wrangler deploy`
- Reuse an already approved build token and GitHub App repository access.
- Do not auto-create credentials or expand App access. If the repository is outside current access, obtain an explicit repository-scoped grant first.

A successful build tied to a specific pushed commit is required to verify automatic deployment; a saved trigger alone is insufficient.

## License and artwork

MIT, copyright 2026 Bit Office contributors. Code and SVG pixel pets / furniture are original to this repository. User-supplied reference screenshots and external artifact source are not redistributed or relicensed here. Third-party dependencies retain their respective licenses.
