/**
 * Worker entry point -- LLM-only MCP server for resume/ATS review.
 *
 * No public-facing UI, but publicly reachable: this is a tool meant to
 * be discovered and called by any MCP-compatible AI agent (registered in
 * the MCP registry), not gated behind aliameen.com. Cost/abuse control is
 * the per-client-minute limiter plus a global 100/day cap (ratelimit.ts),
 * not an auth secret -- a public tool with no accounts has no identity to
 * gate on anyway. aliameen.com's Pages service binding
 * (functions/ats/api/[[path]].ts in the website repo) is one caller among
 * others, not a required proxy.
 *
 * Route: POST /mcp -- MCP Streamable HTTP transport (single endpoint,
 * per the MCP spec), stateless (sessionIdGenerator: undefined) since
 * each analyze_resume call is self-contained -- no reason to hold
 * session state across requests.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createAtsServer } from "./mcp";
import { checkAndRecordRateLimit, checkAndRecordDailyLimit, clientIdFromRequest } from "./ratelimit";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const clientId = clientIdFromRequest(request);
    const withinLimit = await checkAndRecordRateLimit(env.ATS_DB, clientId);
    if (!withinLimit) {
      return new Response("Rate limit exceeded. Try again shortly.", { status: 429 });
    }

    const withinDailyLimit = await checkAndRecordDailyLimit(env.ATS_DB);
    if (!withinDailyLimit) {
      return new Response("Daily request limit reached. Try again tomorrow.", { status: 429 });
    }

    const server = createAtsServer(env, clientId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session resumption needed for a single-tool server
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
