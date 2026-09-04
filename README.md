# ats-worker

An MCP (Model Context Protocol) server for resume/ATS review. **LLM-only** — there
is no public UI, no accounts, no human-facing page. An AI agent uploads a resume
and gets back an ATS-style score and improvement suggestions.

## What it does

One tool: `analyze_resume(resume_base64, mime_type?, target_role?, target_location?)`.

1. Parses the file (PDF via `unpdf`, DOCX via `mammoth`, or plain text), capped at 2MB.
2. Runs a **deterministic** scorer (`src/score.ts`) — parseability, section coverage,
   contact info, keyword overlap with the target role — no LLM involved, so this half
   of the score is reproducible and free.
3. Sends the extracted text to Groq (`openai/gpt-oss-120b`) for qualitative strengths
   and suggestions. This call can fail without affecting the score above.
4. Stores the submission (parsed text, score, suggestions) in D1, kept indefinitely.

## Architecture

```
LLM agent
   │  POST https://aliameen.com/ats/api/mcp
   ▼
aliameen-website (Pages Function, functions/ats/api/[[path]].ts)
   │  attaches X-ATS-Shared-Secret, forwards to /mcp
   │  service binding ATS_API (same-origin, no public URL, no CORS)
   ▼
ats-worker (this repo)
   │  verifies shared secret, rate-limits by IP (D1, 5 req/min)
   ▼
MCP server (src/mcp.ts) → parse → score → Groq → D1
```

Same pattern as this account's other Workers behind aliameen.com
(`keystone`, `clipper-suggestions`, `claude-e-azam`, `verbatim-*`): a standalone
Worker repo, `workers_dev: false`, reached only via a Cloudflare Pages service
binding. There is no other public entry point.

## Security posture

- **No public URL.** `workers_dev: false`; only reachable via the website's service
  binding, which is the only place `ATS_SHARED_SECRET` is attached to a request.
  The Worker itself checks that header (`src/index.ts`) as a second layer.
- **Rate limiting.** App-level, D1-backed, 5 requests/minute per IP (`src/ratelimit.ts`),
  layered under Cloudflare's zone-level rate-limiting rules (configured in the
  dashboard, not here).
- **Prompt-injection posture.** Resume text is untrusted third-party content that an
  LLM is asked to read — the whole point of this tool. It is:
  - Framed strictly as *data to evaluate*, never as instructions, in the Groq system
    prompt (`src/groq.ts`), wrapped in explicit delimiters.
  - Never allowed to influence control flow — the tool surface is fixed
    (`analyze_resume` only); resume content only ever flows into the scoring prompt.
  - Constrained on output: Groq's response must match a strict JSON schema (`zod`),
    validated before use; anything else is treated as a failed call, not surfaced.
  - Flagged (not blocked) by a heuristic pattern match (`src/injection.ts`) for
    dashboard visibility — defense in depth, not the primary defense.
- **Input limits.** 2MB file size cap, 50,000 character cap on extracted text.
- **Data retention.** Submissions (parsed resume text + score + suggestions) are kept
  indefinitely in D1, by explicit owner decision — this is a low-volume personal tool,
  not a consumer product. Viewable at `aliameen.com/analytics` (password-gated, same
  gate as the rest of the analytics dashboard).

## Local development

```
npm install
npx wrangler dev
```

Secrets (never committed):

```
npx wrangler secret put GROQ_API_KEY       # https://console.groq.com
npx wrangler secret put ATS_SHARED_SECRET  # must match the value set on the
                                            # aliameen-website Pages project
```

## Database

```
npx wrangler d1 create ats-db
npx wrangler d1 execute ats-db --remote --file=migrations/0001_ats_schema.sql
```

Two tables: `ats_submissions` (every analysis, kept indefinitely) and
`ats_rate_limits` (fixed-window counters). The website repo binds the same
database read-only to power the `/analytics` dashboard's ATS tab.

## Deploy

```
npx wrangler deploy
```

Then, in the `aliameen-website` repo, make sure `wrangler.jsonc` has the
`ATS_API` service binding and `ATS_DB` D1 binding pointing at this Worker/database,
and that `ATS_SHARED_SECRET` is set as a Pages secret with the same value.
