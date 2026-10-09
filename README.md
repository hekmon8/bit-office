# Bit 小屋 · Bit Office

An original pixel-pet office floor plan, deployed on Cloudflare Workers with a read-only **Streamable HTTP MCP** endpoint.

Demo: https://agents.hekmon.com

The original https://bit-office.macros-hekk.workers.dev address remains available.

## What runs here

- Top-down office: meeting rooms, discussion room, desks, kitchen, fishing pond, charging nests.
- Space-first desktop and mobile map with pan, zoom and pet / occupied-desk task details. Room lists, status, settings and MCP instructions open in dismissible dialogs with back navigation and focus restoration.
- Browser-only demo activity changes and bounded meeting-room expansion.
- Five public read-only MCP tools returning **synthetic sample data only**.
- An optional server-side MCP client and a protected office-state adapter, configured with a URL, authentication type and server-stored token.
- Separate execution counts, connectivity, task handoff evidence and observation timestamps. The compact source badge remains visible; successful reads expire after two minutes and offline fallback is explicit.

The public server is stateless. Browser simulation is private to the current page and resets on reload; it does not update the MCP snapshot. No real Multica workspace, agent, task, credential or execution runtime is configured by default. All members and events are illustrative. “Meeting”, “resting” and “fishing” are demo animations, not inferred from runtime idleness.

## Local development

Requires Node 22.12+ and npm.

```sh
npm ci
npm run check
npm run build
npm run dev:worker
```

Open http://localhost:8787. For UI hot reload, keep the Worker running and run `npm run dev` in another terminal. Vite proxies the demo API and MCP to the local Worker.

## ChatGPT / MCP

Endpoint: `https://agents.hekmon.com/mcp`.

The public demo does not require authentication because it exposes no private data. Configure a remote MCP app with the Streamable HTTP endpoint and “no authentication”, if your ChatGPT account / workspace permits it. Scan tools, then read the synthetic office state. Actual ChatGPT connection must be tested separately; a local MCP test is not that verification.

| Tool | Purpose |
| --- | --- |
| `get_office_state` | Synthetic agents, rooms and independent execution counts |
| `get_agent_state` | One demo agent, tasks, connectivity and timestamps |
| `list_rooms` | Demo room occupancy |
| `get_task_handoff` | Explicit synthetic delegation, not retry parent IDs |
| `get_connection_info` | Data provenance and unconnected integrations |

There are no write tools, generic upstream proxy, agent execution or shared demo mutations. `GET /api/demo/state` and the public `/mcp` always serve the same synthetic source. The protected `/api/live/*` adapter requires explicit server configuration and a separate read credential; it never changes the public demo.

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

- `mode`: `live` with `source: "mcp"`, or `demo` with `source: "synthetic"`. Synthetic sources stay synthetic after connection.
- `observedAt`: the source's ISO timestamp; not replaced by the adapter's read time.
- `rooms`: `{ id, name, kind, topic, capacity, x, y, w, h }`, using the existing activity names (`working`, `meeting`, `discussing`, `resting`, `fishing`, `offline`).
- `agents`: `{ id, name, color, activity, roomId, online, lastSeenAt, tasks, tasksComplete? }`. `lastSeenAt` may be `null`; missing `tasksComplete` defaults to `false`, so an empty task list is unknown rather than idle.
- `tasks`: `{ id, title, status, blocked?, delegatedFrom?, handoffNote?, updatedAt?, handoffAt? }`, using the task statuses in `src/model.ts`.
- `events`: `{ at, message }[]`.

IDs must be unique and contain only letters, digits, `_` or `-`; room references and capacity must be valid. Invalid timestamps, unsafe colors, contradictory provenance and out-of-bounds collections/geometry are rejected. Only known fields are returned, not upstream metadata or credential fields. The adapter adds `lastSuccessfulReadAt`, `snapshotFresh` (source observation no older than two minutes and not in the future), and each agent's `execution`. Task-event, heartbeat, source-observation and successful-read timestamps stay distinct.

## Real data boundary

Use an upstream credential issued for the intended MCP service, workspace and read scopes. The upstream service remains responsible for validating its token issuer, audience, expiry and workspace membership. The adapter uses a separate operator-managed read token for its single configured source; it does not provide multi-user or workspace authorization. Do not copy browser cookies or private source code into this project. Do not forward one resource's token to a different audience. Store secrets only in an approved secret store; never in this repository.

Online is independent of running. Running and queued tasks can coexist. A blocked issue is evidence for its task, not evidence that all execution stopped. Incomplete or stale task reads yield unknown rather than idle. Last successful read, task event and heartbeat times must remain distinct.

## Deployment

```sh
npm run check
npm run deploy
```

Cloudflare account authentication must already exist. This project needs only a Worker and static assets: no database, paid add-on, new application credential or GitHub Actions workflow.

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
