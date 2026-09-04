// The MCP server itself: one tool, analyze_resume. Built fresh per
// request (see index.ts) since Workers has no persistent process to hold
// a long-lived server instance across requests, and this tool is
// stateless anyway -- each call is a single self-contained analysis.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseResume, ResumeParseError, MAX_UPLOAD_BYTES } from "./parse";
import { scoreResume } from "./score";
import { getQualitativeSuggestions } from "./groq";
import { detectInjectionAttempt } from "./injection";
import { recordSubmission } from "./db";
import type { Env } from "./env";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function createAtsServer(env: Env, clientId: string): McpServer {
  const server = new McpServer({
    name: "ats-resume-review",
    version: "0.1.0",
  });

  server.registerTool(
    "analyze_resume",
    {
      title: "Analyze resume for ATS fit",
      description:
        `Upload a resume (PDF, DOCX, or plain text, base64-encoded, up to ${MAX_UPLOAD_BYTES / 1024 / 1024}MB) ` +
        "and get back an ATS-style parseability/keyword score (0-100) plus qualitative " +
        "strengths and improvement suggestions. Optionally provide the role and location " +
        "the candidate is targeting to score keyword alignment against it.",
      inputSchema: {
        resume_base64: z.string().min(1).describe("The resume file, base64-encoded."),
        mime_type: z
          .string()
          .optional()
          .describe("Optional MIME type hint, e.g. application/pdf. File content is auto-detected regardless."),
        target_role: z
          .string()
          .max(200)
          .optional()
          .describe("The job title/role the candidate is applying for, e.g. 'Senior Backend Engineer'."),
        target_location: z
          .string()
          .max(200)
          .optional()
          .describe("The location the candidate is targeting, e.g. 'Remote, US' or 'London, UK'."),
      },
    },
    async ({ resume_base64, mime_type, target_role, target_location }) => {
      const startedAt = Date.now();

      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(resume_base64);
      } catch {
        return errorResult("resume_base64 is not valid base64.");
      }

      let parsed;
      try {
        parsed = await parseResume(bytes, mime_type);
      } catch (err) {
        if (err instanceof ResumeParseError) return errorResult(err.message);
        throw err;
      }

      const flaggedInjection = detectInjectionAttempt(parsed.text);
      const score = scoreResume(parsed.text, target_role);
      const suggestions = await getQualitativeSuggestions(
        env.GROQ_API_KEY,
        parsed.text,
        target_role,
        target_location
      );

      const id = crypto.randomUUID();
      await recordSubmission(env.ATS_DB, {
        id,
        targetRole: target_role,
        targetLocation: target_location,
        resumeText: parsed.text,
        fileKind: parsed.fileKind,
        score,
        suggestions,
        flaggedInjection,
        clientId,
        durationMs: Date.now() - startedAt,
      });

      const responsePayload = {
        score: score.total,
        score_breakdown: {
          parseability: score.parseability,
          section_coverage: score.sectionCoverage,
          keyword_coverage: score.keywordCoverage,
          contact_info: score.contactInfo,
        },
        notes: score.notes,
        strengths: suggestions?.strengths ?? [],
        suggestions: suggestions?.suggestions ?? [],
        summary: suggestions?.summary ?? null,
        file_kind: parsed.fileKind,
        truncated: parsed.truncated,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(responsePayload, null, 2) }],
      };
    }
  );

  return server;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
