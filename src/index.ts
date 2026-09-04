/**
 * Worker entry point -- LLM-only MCP server for resume/ATS review.
 *
 * No public-facing UI. Reached in production only through
 * aliameen.com's Pages service binding (functions/ats/api/[[path]].ts
 * in the website repo), which is itself the only place ATS_SHARED_SECRET
 * is attached to outgoing requests -- so a client must go through that
 * documented path. workers_dev is off in wrangler.jsonc as the first
 * layer; this shared-secret check is the second, in case that ever
 * changes or the binding is bypassed some other way.
 *
 * Route: POST /mcp -- MCP Streamable HTTP transport (single endpoint,
 * per the MCP spec), stateless (sessionIdGenerator: undefined) since
 * each analyze_resume call is self-contained -- no reason to hold
 * session state across requests.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createAtsServer } from "./mcp";
import { checkAndRecordRateLimit, clientIdFromRequest } from "./ratelimit";
import type { Env } from "./env";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const provided = request.headers.get("X-ATS-Shared-Secret") ?? "";
    if (!provided || !timingSafeEqual(provided, env.ATS_SHARED_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const clientId = clientIdFromRequest(request);
    const withinLimit = await checkAndRecordRateLimit(env.ATS_DB, clientId);
    if (!withinLimit) {
      return new Response("Rate limit exceeded. Try again shortly.", { status: 429 });
    }

    const server = createAtsServer(env, clientId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session resumption needed for a single-tool server
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
