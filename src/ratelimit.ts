// Fixed-window rate limit backed by D1 (ats_rate_limits). One row per
// (client_id, minute window). This is app-level, tool-call-aware
// granularity, layered under Cloudflare's zone-level rate limiting rules
// (configured separately in the dashboard, not in code) which handle raw
// request-flood protection before this ever runs.

const WINDOW_SECONDS = 60;
const MAX_REQUESTS_PER_WINDOW = 5;

function currentWindowStart(): string {
  const now = new Date();
  const windowMs = WINDOW_SECONDS * 1000;
  const aligned = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  return aligned.toISOString();
}

export async function checkAndRecordRateLimit(db: D1Database, clientId: string): Promise<boolean> {
  const windowStart = currentWindowStart();

  const result = await db
    .prepare(
      `INSERT INTO ats_rate_limits (client_id, window_start, request_count)
       VALUES (?1, ?2, 1)
       ON CONFLICT(client_id, window_start)
       DO UPDATE SET request_count = request_count + 1
       RETURNING request_count`
    )
    .bind(clientId, windowStart)
    .first<{ request_count: number }>();

  return (result?.request_count ?? 0) <= MAX_REQUESTS_PER_WINDOW;
}

// Best-effort caller identifier: Cloudflare's connecting IP. This is an
// MCP tool with no accounts, so it's the only signal available -- good
// enough to blunt accidental hammering or a single bad actor, not meant
// as a strong identity.
export function clientIdFromRequest(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
