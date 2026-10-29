import type { DurableObjectState } from "@cloudflare/workers-types";
import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const command = z.discriminatedUnion("operation", [
 z.strictObject({ operation: z.literal("create"), session: hash, fingerprint: hash, replace: hash.optional() }),
 z.strictObject({ operation: z.literal("check"), session: hash, fingerprint: hash }),
 z.strictObject({ operation: z.literal("revoke"), session: hash }),
 z.strictObject({ operation: z.literal("attempt"), bucket: hash })
]);
type Session = { session: string; fingerprint: string; expires: number };
export const viewerSessionSeconds = 30 * 24 * 60 * 60;
/** Strongly consistent auth-only keys; never included in the office snapshot. */
export async function viewerStore(request: Request, state: DurableObjectState): Promise<Response> {
 if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
 const parsed = command.safeParse(await request.json());
 if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
 const now = Date.now(), input = parsed.data;
 return state.storage.transactionSync(() => {
  if (input.operation === "attempt") {
   const old = state.storage.kv.get<{ global: number; reset: number; buckets: { key: string; count: number }[] }>("viewer:attempts");
   const limits = old && old.reset > now ? old : { global: 0, reset: now + 60000, buckets: [] };
   const bucket = limits.buckets.find(b => b.key === input.bucket);
   if (limits.global >= 100 || (bucket?.count ?? 0) >= 10 || (!bucket && limits.buckets.length >= 100)) return Response.json({ error: "rate_limited" }, { status: 429 });
   limits.global++; if (bucket) bucket.count++; else limits.buckets.push({ key: input.bucket, count: 1 });
   state.storage.kv.put("viewer:attempts", limits); return Response.json({ allowed: true });
  }
  let sessions = (state.storage.kv.get<Session[]>("viewer:sessions") ?? []).filter(s => s.expires > now);
  if (input.operation === "check") {
   return Response.json({ authorized: sessions.some(s => s.session === input.session && s.fingerprint === input.fingerprint), scope: "viewer:read" });
  }
  if (input.operation === "revoke") sessions = sessions.filter(s => s.session !== input.session);
  else {
   if (input.replace) sessions = sessions.filter(s => s.session !== input.replace);
   if (sessions.length >= 50) return Response.json({ error: "session_limit" }, { status: 429 });
   sessions.push({ session: input.session, fingerprint: input.fingerprint, expires: now + viewerSessionSeconds * 1000 });
  }
  state.storage.kv.put("viewer:sessions", sessions);
  return Response.json({ ok: true });
 });
}
