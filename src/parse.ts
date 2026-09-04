// Extracts plain text from an uploaded resume. Raw file bytes are never
// persisted (see db.ts) -- only the text this module returns.

import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MiB -- resumes are text-dense, this is generous
export const MAX_RESUME_CHARS = 50_000; // guards parse cost and downstream Groq prompt size

export type FileKind = "pdf" | "docx" | "text";

export interface ParsedResume {
  text: string;
  fileKind: FileKind;
  truncated: boolean;
}

export class ResumeParseError extends Error {}

function detectKind(bytes: Uint8Array, declaredMimeType: string | undefined): FileKind {
  // PDF magic bytes: "%PDF"
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "pdf";
  }
  // DOCX (and other OOXML) is a zip: "PK\x03\x04"
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "docx";
  }
  if (declaredMimeType === "application/pdf") return "pdf";
  if (declaredMimeType?.includes("wordprocessingml")) return "docx";
  return "text";
}

export async function parseResume(bytes: Uint8Array, declaredMimeType?: string): Promise<ParsedResume> {
  if (bytes.byteLength === 0) throw new ResumeParseError("Empty file.");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ResumeParseError(`File exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit.`);
  }

  const fileKind = detectKind(bytes, declaredMimeType);
  let text: string;

  try {
    if (fileKind === "pdf") {
      const pdf = await getDocumentProxy(bytes);
      const result = await extractText(pdf, { mergePages: true });
      text = Array.isArray(result.text) ? result.text.join("\n") : result.text;
    } else if (fileKind === "docx") {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      text = result.value;
    } else {
      text = new TextDecoder("utf-8").decode(bytes);
    }
  } catch (err) {
    // Raw library error text (unpdf/mammoth internals) is logged for our
    // own visibility but not handed to the caller -- it's unfiltered
    // internal detail reaching an untrusted client for no benefit to them.
    console.error(`Resume parse failure (${fileKind}):`, err instanceof Error ? err.message : String(err));
    throw new ResumeParseError(`Could not parse file as ${fileKind}.`);
  }

  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();

  if (!text) {
    throw new ResumeParseError(
      "No extractable text found. The file may be a scanned image without a text layer."
    );
  }

  const truncated = text.length > MAX_RESUME_CHARS;
  if (truncated) text = text.slice(0, MAX_RESUME_CHARS);

  return { text, fileKind, truncated };
}
