// Deterministic ATS-style scoring. No LLM involved here on purpose --
// this half of the score must be reproducible, free, and fast. The Groq
// pass (groq.ts) only ever adds qualitative *suggestions* on top; it
// never changes this number.

export interface ScoreBreakdown {
  total: number; // 0-100
  parseability: number; // 0-40: is this resume machine-readable at all
  sectionCoverage: number; // 0-25: standard resume sections present
  keywordCoverage: number; // 0-25: overlap with the target role's likely keywords
  contactInfo: number; // 0-10: findable contact info
  notes: string[];
}

const SECTION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "experience", pattern: /\b(experience|employment history|work history)\b/i },
  { name: "education", pattern: /\beducation\b/i },
  { name: "skills", pattern: /\b(skills|technical skills|core competencies)\b/i },
  { name: "summary", pattern: /\b(summary|objective|profile)\b/i },
];

// Formatting patterns that commonly break real ATS parsers even though
// a human (or a general-purpose LLM reading raw text) would follow them
// fine. This is scored from the *extracted text*, so we look for signals
// text extraction leaves behind, not the original layout.
function scoreParseability(text: string): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 40;

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const avgLineLen = lines.reduce((sum, l) => sum + l.length, 0) / Math.max(lines.length, 1);

  // Tables/columns often extract as heavily fragmented short lines.
  if (avgLineLen < 20 && lines.length > 40) {
    score -= 12;
    notes.push("Text extracts as many short fragments -- likely a multi-column or table-based layout, which many ATS parsers scramble.");
  }

  // Unusual bullet/glyph characters that sometimes indicate icon fonts
  // (common in "designed" resume templates) rendering as garbage.
  const glyphNoise = (text.match(/[-]/g) || []).length;
  if (glyphNoise > 3) {
    score -= 10;
    notes.push("Contains private-use-area glyphs, often icon fonts (e.g. a phone/email icon) that ATS parsers render as garbled characters or drop.");
  }

  // A resume with almost no line breaks likely lost its structure entirely.
  if (lines.length < 5 && text.length > 500) {
    score -= 15;
    notes.push("Very few line breaks detected -- structure may have collapsed during extraction (common with image-based or heavily-designed PDFs).");
  }

  if (text.length < 400) {
    score -= 10;
    notes.push("Extracted text is unusually short for a resume -- check the file isn't mostly a scanned image.");
  }

  return { score: Math.max(0, score), notes };
}

function scoreSections(text: string): { score: number; notes: string[] } {
  const notes: string[] = [];
  const perSection = 25 / SECTION_PATTERNS.length;
  let score = 0;

  for (const { name, pattern } of SECTION_PATTERNS) {
    if (pattern.test(text)) {
      score += perSection;
    } else {
      notes.push(`No clearly-labeled "${name}" section detected.`);
    }
  }

  return { score: Math.round(score), notes };
}

function scoreContactInfo(text: string): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 0;

  const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text);
  const hasPhone = /(\+?\d[\d\s().-]{8,}\d)/.test(text);

  if (hasEmail) score += 6;
  else notes.push("No email address detected in extracted text.");

  if (hasPhone) score += 4;
  else notes.push("No phone number detected in extracted text.");

  return { score, notes };
}

// Cheap keyword extraction from a free-text target role, e.g.
// "Senior Backend Engineer, Node.js/AWS" -> ["senior","backend","engineer","node.js","aws"].
function extractRoleKeywords(targetRole: string): string[] {
  return Array.from(
    new Set(
      targetRole
        .toLowerCase()
        .split(/[^a-z0-9+.#]+/i)
        .map((w) => w.trim())
        .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    )
  );
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "of", "in", "at", "to", "with", "role", "position", "job",
]);

function scoreKeywordCoverage(text: string, targetRole: string | undefined): { score: number; notes: string[] } {
  if (!targetRole || !targetRole.trim()) {
    return { score: 25, notes: ["No target role provided -- keyword coverage not scored (full credit given)."] };
  }

  const keywords = extractRoleKeywords(targetRole);
  if (keywords.length === 0) {
    return { score: 25, notes: [] };
  }

  const lowerText = text.toLowerCase();
  const matched = keywords.filter((kw) => lowerText.includes(kw));
  const ratio = matched.length / keywords.length;
  const score = Math.round(ratio * 25);

  const missing = keywords.filter((kw) => !matched.includes(kw));
  const notes: string[] = [];
  if (missing.length > 0) {
    notes.push(`Target role terms not found in resume text: ${missing.join(", ")}.`);
  }

  return { score, notes };
}

export function scoreResume(text: string, targetRole: string | undefined): ScoreBreakdown {
  const parseability = scoreParseability(text);
  const sections = scoreSections(text);
  const contact = scoreContactInfo(text);
  const keywords = scoreKeywordCoverage(text, targetRole);

  const total = Math.round(parseability.score + sections.score + contact.score + keywords.score);

  return {
    total: Math.max(0, Math.min(100, total)),
    parseability: parseability.score,
    sectionCoverage: sections.score,
    keywordCoverage: keywords.score,
    contactInfo: contact.score,
    notes: [...parseability.notes, ...sections.notes, ...contact.notes, ...keywords.notes],
  };
}
