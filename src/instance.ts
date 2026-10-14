export type InstanceMode = "demo" | "private" | "compatible";
export function instanceMode(value?: string): InstanceMode | null {
 return value === undefined ? "compatible" : value === "demo" || value === "private" ? value : null;
}
export const instanceHeaders = {
 "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY"
};
export function instanceJson(value: unknown, status = 200) { return Response.json(value, { status, headers: instanceHeaders }); }
