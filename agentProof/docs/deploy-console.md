# Deploying the console to Vercel

The console is one workspace package inside a pnpm monorepo that itself sits in
a subdirectory of the git repository. Both of those facts have to be told to
Vercel explicitly; neither is inferred correctly by default.

## Project settings

| Setting | Value |
| --- | --- |
| Root Directory | `agentProof/apps/console` |
| Include source files outside of the Root Directory | **enabled** |
| Framework Preset | Next.js |
| Node.js Version | 22.x |

The "include source files outside of the Root Directory" toggle is not
optional. The console depends on three `workspace:*` packages —
`@agentproof/design`, `@agentproof/sdk`, `@agentproof/x402-client` — and on a
`pnpm-lock.yaml` and a `packageManager` pin that both live at the workspace
root, one level above the Root Directory. With the toggle off, Vercel uploads
only `apps/console` and install fails before a single file is compiled.

The Root Directory is **case-sensitive**: `agentProof/apps/console`, capital P.
A lowercase `agentproof/...` fails immediately after the clone with "The
specified Root Directory does not exist", before install runs.

`vercel.json` deliberately sets nothing but the framework preset. An earlier
version overrode `installCommand` and `buildCommand` to `cd ../..` into the
workspace root; the build itself succeeded, but Vercel's packaging step then
could not resolve `next` through pnpm's symlinked `node_modules` and failed
with:

    Cannot find module 'next/dist/compiled/next-server/server.runtime.prod.js'

Vercel already knows how to find a pnpm workspace root from an app
subdirectory. Doing it by hand put the install somewhere its own tracing step
did not look for it. Leave install and build on auto-detect.

## Environment variables

These are read while the build runs, not after it. A variable added to the
project after a deployment does not reach that deployment — redeploy.

| Variable | Required | Effect if unset |
| --- | --- | --- |
| `AGENTPROOF_API_URL` | yes | `/api/v1/*` proxies to `127.0.0.1:8402`, which does not exist on Vercel. Every call 502s. Falls back to `API_PUBLIC_URL` when that is set. |
| `API_PUBLIC_URL` | recommended | The Integrations panel omits the public API link. Also serves as the `AGENTPROOF_API_URL` fallback. |
| `GRAPH_ENDPOINT` | no | Falls back to the published Studio endpoint compiled into `lib/deployments.ts`. |

Set `AGENTPROOF_API_URL` to the same publicly reachable address the gateway
uses. During the demo that is the Cloudflare quick tunnel recorded in `.env` as
`API_PUBLIC_URL` — and a quick tunnel gets a fresh hostname on every restart, so
a console deployed against a stale one is proxying to a dead host. Redeploy
after the tunnel rotates.

`/api/v1/verify` is not proxied by a rewrite; it is a route handler
(`app/api/v1/verify/route.ts`) that pays the x402 gate and holds the request
open for escalated approvals. It reads the same variables at request time, so it
picks up a change on the next deployment without a rebuild of the client bundle.

## Verifying a build locally

```bash
pnpm --filter @agentproof/console build
```

from the workspace root reproduces exactly what Vercel runs. A stale
`apps/console/.next` can produce a spurious `Cannot find module for page:
/_not-found`; remove it before trusting a failure.
