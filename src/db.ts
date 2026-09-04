import type { ScoreBreakdown } from "./score";
import type { GroqSuggestions } from "./groq";
import type { FileKind } from "./parse";

export interface SubmissionRecord {
  id: string;
  targetRole: string | undefined;
  targetLocation: string | undefined;
  resumeText: string;
  fileKind: FileKind;
  score: ScoreBreakdown;
  suggestions: GroqSuggestions | null;
  flaggedInjection: boolean;
  clientId: string;
  durationMs: number;
}

export async function recordSubmission(db: D1Database, rec: SubmissionRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ats_submissions
         (id, target_role, target_location, resume_text, resume_char_count, file_kind,
          score, score_breakdown, suggestions, flagged_injection, client_id, duration_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
    )
    .bind(
      rec.id,
      rec.targetRole ?? null,
      rec.targetLocation ?? null,
      rec.resumeText,
      rec.resumeText.length,
      rec.fileKind,
      rec.score.total,
      JSON.stringify(rec.score),
      rec.suggestions ? JSON.stringify(rec.suggestions) : null,
      rec.flaggedInjection ? 1 : 0,
      rec.clientId,
      rec.durationMs
    )
    .run();
}
