-- Global daily request cap, independent of the per-client-minute limiter
-- in ats_rate_limits. Single row per UTC date; see src/ratelimit.ts
-- (checkAndRecordDailyLimit) for how it's used.
CREATE TABLE IF NOT EXISTS ats_daily_limits (
  day TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0
);
