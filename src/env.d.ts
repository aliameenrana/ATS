// Bindings/secrets declared in wrangler.jsonc. See that file for how each
// binding is provisioned and how each secret is set (`wrangler secret put`).

export interface Env {
  // D1 -- resume submissions (parsed text + score + suggestions, kept
  // indefinitely) and rate-limit counters. Read by the website's
  // /analytics dashboard through a separate D1 binding of the same
  // database (see aliameen-website/wrangler.jsonc).
  ATS_DB: D1Database;

  // Secrets (never committed).
  GROQ_API_KEY: string;
}
