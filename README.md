# ATS Resume Review — MCP Server

An **MCP (Model Context Protocol) server** for AI-powered resume review and ATS
(Applicant Tracking System) scoring, built as a Cloudflare Worker. Designed for
**LLM-only access** — there is no public web UI, no human-facing page, and no
accounts. An AI agent (Claude, or any MCP-compatible client) connects, uploads a
resume, and receives a structured ATS score and improvement suggestions.

**Tags:** `mcp-server` `model-context-protocol` `ats-score` `resume-parser`
`resume-analyzer` `applicant-tracking-system` `cloudflare-workers` `typescript`
`llm-tools` `ai-agent-tools` `groq` `resume-checker` `job-application-tools`

## What it does

A single MCP tool, `analyze_resume(resume_base64, mime_type?, target_role?, target_location?)`:

1. **Parses** the uploaded resume — PDF (via `unpdf`), DOCX (via `mammoth`), or
   plain text — capped at 2MB.
2. **Scores it deterministically** (`src/score.ts`): ATS parseability (tables,
   columns, icon-font glyphs that break real parsers), standard section coverage
   (experience/education/skills/summary), contact-info detectability, and keyword
   overlap against the target role. No LLM in this half of the score, so it's
   reproducible and free to run.
3. **Adds qualitative feedback** via the Groq API (`openai/gpt-oss-120b`) —
   strengths, specific improvement suggestions, and a short summary. This call is
   fully decoupled from the score above; if it fails, the score still returns.
4. **Persists the submission** (parsed text, score breakdown, suggestions) to
   Cloudflare D1.

## Why MCP, and why LLM-only

This isn't a SaaS product with a landing page — it's infrastructure meant to be
*discovered and called by AI agents*, the same way a REST API is discovered and
called by other software. MCP is the emerging standard for that: a typed tool
contract an LLM client can introspect (`tools/list`) and invoke (`tools/call`)
over a documented transport (Streamable HTTP), without scraping a UI or parsing
HTML. Building this as an MCP server rather than a REST endpoint with a Swagger
page is a deliberate bet on how AI agents will source capabilities going forward.

## Architecture

```
MCP client (AI agent)
   │  POST /mcp  — JSON-RPC 2.0 over Streamable HTTP
   ▼
Cloudflare Worker (this repo)
   │  shared-secret auth → D1-backed rate limit (5 req/min/IP)
   ▼
parse (PDF/DOCX/text) → deterministic score → Groq qualitative pass → D1
```

Reached in production only through a same-origin Cloudflare Pages service
binding on a separate site — no public `workers.dev` URL is exposed. That's a
deployment detail, not a requirement of the code here: point any MCP-compatible
transport at `POST /mcp` and it works.

## Security & reliability engineering

Built as a tool that must survive **untrusted third-party input read by an LLM**
— the resume itself is attacker-reachable content, not a trusted API payload.

- **Prompt-injection resistant by construction.** The resume text is framed
  strictly as *data to evaluate*, never as instructions, inside the Groq system
  prompt — wrapped in explicit delimiters, with an instruction to flag rather
  than obey anything that looks like a directive. Tool selection and control
  flow never depend on resume content; only one tool exists. Output is
  constrained to a `zod`-validated JSON schema, so even a successful injection
  can only emit text that still has to fit `{summary, strengths[], suggestions[]}`.
  A secondary heuristic pass (`src/injection.ts`) flags suspected attempts for
  audit visibility — defense in depth, not the primary defense.
- **Rate limiting.** D1-backed fixed-window counter per client IP, layered under
  zone-level Cloudflare rate-limiting rules.
- **Shared-secret auth** on top of the network-level access restriction (no
  public URL), so the tool is authenticated even if network exposure ever
  changes.
- **Bounded input.** 2MB file-size cap, 50,000-character cap on extracted text,
  15-second timeout on the LLM call — all sized to make cost and abuse
  predictable regardless of what's uploaded.
- **Deterministic core.** The ATS score itself never depends on an LLM call
  succeeding, being available, or being non-deterministic — only the
  qualitative suggestions layer does.

## Stack

Cloudflare Workers · TypeScript · `@modelcontextprotocol/sdk` (Streamable HTTP
transport) · Cloudflare D1 · Groq API · `zod` · `unpdf` · `mammoth`

## Local development

```
npm install
npx wrangler dev
```

Secrets (never committed):

```
npx wrangler secret put GROQ_API_KEY       # https://console.groq.com
npx wrangler secret put ATS_SHARED_SECRET  # any caller must present this
                                            # in X-ATS-Shared-Secret
```

## Database

```
npx wrangler d1 create ats-db
npx wrangler d1 execute ats-db --remote --file=migrations/0001_ats_schema.sql
```

Two tables: `ats_submissions` (every analysis) and `ats_rate_limits`
(fixed-window counters).

## Deploy

```
npx wrangler deploy
```

## Project layout

```
src/
  index.ts      Worker entrypoint — auth, rate limiting, MCP transport wiring
  mcp.ts        MCP server + the analyze_resume tool definition
  parse.ts      PDF/DOCX/text extraction
  score.ts      Deterministic ATS scoring
  groq.ts       Qualitative suggestions via Groq, injection-safe prompt framing
  injection.ts  Heuristic prompt-injection detection (audit flag, not a gate)
  db.ts         D1 writes
  ratelimit.ts  D1-backed fixed-window rate limiter
migrations/     D1 schema
```
