# Bit 小屋 · Bit Office

An original pixel-pet office floor plan, deployed on Cloudflare Workers with a read-only **Streamable HTTP MCP** endpoint.

Demo: https://bit-office.macros-hekk.workers.dev

## What runs here

- Top-down office: meeting rooms, discussion room, desks, kitchen, fishing pond, charging nests.
- Desktop map with pan, zoom and pet / room details. Mobile opens a room-list view with modal room and agent details.
- Browser-only demo activity changes and bounded meeting-room expansion.
- Five read-only MCP tools returning **synthetic sample data only**.
- Separate execution counts, connectivity, task handoff evidence and observation timestamps.

The public server is stateless. Browser simulation is private to the current page and resets on reload; it does not update the MCP snapshot. No real Multica workspace, agent, task, credential or execution runtime is connected. All members and events are illustrative. “Meeting”, “resting” and “fishing” are demo animations, not inferred from runtime idleness.

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

Endpoint: `https://bit-office.macros-hekk.workers.dev/mcp`.

The public demo does not require authentication because it exposes no private data. Configure a remote MCP app with the Streamable HTTP endpoint and “no authentication”, if your ChatGPT account / workspace permits it. Scan tools, then read the synthetic office state. Actual ChatGPT connection must be tested separately; a local MCP test is not that verification.

| Tool | Purpose |
| --- | --- |
| `get_office_state` | Synthetic agents, rooms and independent execution counts |
| `get_agent_state` | One demo agent, tasks, connectivity and timestamps |
| `list_rooms` | Demo room occupancy |
| `get_task_handoff` | Explicit synthetic delegation, not retry parent IDs |
| `get_connection_info` | Data provenance and unconnected integrations |

There are no write tools, generic upstream proxy, agent execution or shared demo mutations. `GET /api/demo/state` serves the same synthetic source. `/api/live*` fails closed; a flag cannot enable real data.

## Real data boundary

A future adapter needs separately approved identity, workspace and read scopes. It must verify token issuer / audience / expiry, workspace membership and server-side scope restrictions before returning any data. Do not copy browser cookies or private source code into this project. Do not forward one resource's token to a different audience. Store secrets only in an approved secret store; never in this repository.

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
- PR candidates: isolated `bit-office-staging` Worker, verified before promotion
- Root: `/`
- Build command: `npm run check`
- Deploy command: `npx wrangler deploy`
- Reuse an already approved build token and GitHub App repository access.
- Do not auto-create credentials or expand App access. If the repository is outside current access, obtain an explicit repository-scoped grant first.

A successful build tied to a specific pushed commit is required to verify automatic deployment; a saved trigger alone is insufficient.

## License and artwork

MIT, copyright 2026 Bit Office contributors. Code and SVG pixel pets / furniture are original to this repository. User-supplied reference screenshots and external artifact source are not redistributed or relicensed here. Third-party dependencies retain their respective licenses.
