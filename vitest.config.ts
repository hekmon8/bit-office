import { defineConfig } from "vitest/config";
export default defineConfig({ test: { server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } }, alias: {
 "cloudflare:workers": new URL("./tests/cloudflare-workers.ts", import.meta.url).pathname
} } });
