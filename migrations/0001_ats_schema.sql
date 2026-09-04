-- Submissions kept indefinitely (owner's explicit choice) so they're
-- reviewable on aliameen.com/analytics. Raw file bytes are never stored --
-- only extracted text (cheaper, and it's the only part worth reviewing).
CREATE TABLE IF NOT EXISTS ats_submissions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  target_role TEXT,
  target_location TEXT,
  resume_text TEXT NOT NULL,
  resume_char_count INTEGER NOT NULL,
  file_kind TEXT NOT NULL,           -- 'pdf' | 'docx' | 'text'
  score INTEGER NOT NULL,            -- 0-100 deterministic ATS score
  score_breakdown TEXT NOT NULL,     -- JSON: {parseability, keywordCoverage, sectionCoverage, ...}
  suggestions TEXT,                  -- JSON array of Groq-generated suggestions (nullable: Groq call can fail/be skipped)
  flagged_injection INTEGER NOT NULL DEFAULT 0, -- 1 if suspected prompt-injection content was detected in the resume
  client_id TEXT,                    -- best-effort caller identifier (see src/ratelimit.ts), for the rate limiter + dashboard, not identity
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ats_submissions_created ON ats_submissions(created_at);

-- Fixed-window rate limiting, one row per (client_id, window_start).
-- Windows are minute-aligned; see src/ratelimit.ts.
CREATE TABLE IF NOT EXISTS ats_rate_limits (
  client_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, window_start)
);
