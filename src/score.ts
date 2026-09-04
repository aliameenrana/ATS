// Deterministic ATS-style scoring. No LLM involved here on purpose --
// this half of the score must be reproducible, free, and fast. The Groq
// pass (groq.ts) only ever adds qualitative *suggestions* on top; it
// never changes this number.
//
// METHODOLOGY NOTE: no major ATS vendor (Workday, Taleo, iCIMS, Greenhouse,
// Lever) publishes the internals of how they parse or rank resumes, and
// no commercial resume-scoring tool (Jobscan, Rezi, Resume Worded) publishes
// a real scoring formula either -- Rezi's own docs state plainly that
// "real ATS systems don't give your resume an official score." This score
// is a heuristic proxy, not a simulation of any specific ATS or a predictor
// of hiring outcomes. What's below is built from documented, sourced
// failure modes (academic resume-parsing literature -- see README) rather
// than folklore, but every check here should be read as "this reduces the
// chance of a known failure mode / rewards a documented convention," not
// "this is what Workday actually does." Where a check has no research
// grounding (the content-quality heuristics below), that's called out
// explicitly rather than presented with false authority.
//
// DESIGN CHOICES THAT DIFFER FROM v1 OF THIS SCORER, AND WHY:
// - Parseability is a MULTIPLIER on the rest of the score, not an
//   independent additive bucket. A resume that fundamentally didn't parse
//   (scanned image, scrambled multi-column text) has garbage in every
//   other category too -- letting it still accumulate points elsewhere
//   was the core bug in v1 (a clean plain-text resume scored 100/100
//   trivially, because "not obviously broken" and "excellent" scored
//   identically).
// - Keyword coverage uses saturating (diminishing-returns) frequency
//   scoring instead of boolean presence, so repeating a term doesn't
//   linearly inflate the score -- this is the standard BM25 fix for
//   keyword-stuffing gaming, adapted here without needing a full BM25
//   corpus since there's no comparable-document set to compute IDF from.
// - Section coverage validates that a detected section has real content
//   (minimum length, expected sub-signals like dates for Experience)
//   rather than awarding full credit the instant a header word appears
//   anywhere in the text.
// - A top score is meant to be rare. Perfectly clean structure and
//   perfect keyword coverage is necessary but not sufficient for 100;
//   the content-quality signal (clearly labeled as style convention, not
//   ATS fact) keeps a merely-adequate resume from maxing out.

export interface ScoreBreakdown {
  total: number; // 0-100
  parseability: number; // 0-100: gate/multiplier, not summed directly into total
  sectionCoverage: number; // 0-25
  keywordCoverage: number; // 0-25
  contactInfo: number; // 0-10
  contentQuality: number; // 0-15 -- style-convention heuristic, not ATS-verified
  notes: string[];
}

// ---------------------------------------------------------------------
// Parseability: detects documented resume-parsing failure modes. Scored
// 0-100 and applied as a multiplier against the rest of the score, since
// a badly-broken extraction makes every other category's input unreliable.
// ---------------------------------------------------------------------

function scoreParseability(text: string): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 100;

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const avgLineLen = lines.reduce((sum, l) => sum + l.length, 0) / Math.max(lines.length, 1);

  // Multi-column/table layouts extract as many short, fragmented lines
  // because linear top-to-bottom extraction interleaves columns. This is
  // the single most-documented ATS parsing failure (affects an estimated
  // ~20% of real-world resumes per layout-parsing research).
  if (avgLineLen < 20 && lines.length > 40) {
    score -= 30;
    notes.push("Text extracts as many short fragments -- likely a multi-column or table-based layout, which real ATS parsers commonly scramble or read out of order.");
  }

  // Private Use Area codepoints (U+E000-U+F8FF) are how icon fonts map
  // glyphs (phone/email/location icons) -- these render as missing or
  // garbled characters in a text-only parser, not the intended icon.
  const puaGlyphs = (text.match(/[-]/g) || []).length;
  if (puaGlyphs > 0) {
    score -= 20;
    notes.push("Contains private-use-area glyphs, typically icon fonts (e.g. a phone/email icon), that ATS parsers render as garbled characters or drop entirely.");
  }

  // Near-zero line breaks on a document of real length suggests structure
  // collapsed during extraction -- common with image-based or heavily
  // "designed" PDFs where the text layer doesn't follow the visual layout.
  if (lines.length < 5 && text.length > 500) {
    score -= 35;
    notes.push("Very few line breaks detected -- structure likely collapsed during extraction (common with image-based or heavily-designed PDFs).");
  }

  // Near-zero extracted text relative to a plausible resume is the
  // clearest hard signal of a scanned-image PDF with no real text layer:
  // zero extractable text means zero parseable content, full stop.
  if (text.length < 400) {
    score -= 40;
    notes.push("Extracted text is unusually short for a resume -- check the file isn't a scanned image with no real text layer.");
  }

  // Inconsistent date formats across entries (mixing "Jan 2022",
  // "01/2022", "2022-01" in the same document) can break structured
  // date-field extraction in real parsers, which generally expect one
  // consistent pattern throughout a document.
  const dateFormats = detectDateFormats(text);
  if (dateFormats.size > 2) {
    score -= 10;
    notes.push("Multiple different date formats detected across the document -- inconsistent date formatting can break structured date extraction.");
  }

  return { score: Math.max(0, Math.min(100, score)), notes };
}

function detectDateFormats(text: string): Set<string> {
  const formats = new Set<string>();
  if (/\b(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}\b/.test(text)) formats.add("year-range");
  if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(19|20)\d{2}\b/i.test(text)) formats.add("month-name-year");
  if (/\b\d{1,2}\/\d{4}\b/.test(text)) formats.add("mm-slash-yyyy");
  if (/\b(19|20)\d{2}-\d{2}\b/.test(text)) formats.add("iso-year-month");
  return formats;
}

// ---------------------------------------------------------------------
// Section coverage: detects section boundaries and validates that each
// has real content, not just a matching header word anywhere in the text.
// ---------------------------------------------------------------------

interface SectionSpec {
  name: string;
  headerPattern: RegExp;
  minContentLines: number;
  // Optional signal that should appear within the section's content if
  // it's a real, substantive section (e.g. dates for Experience).
  contentSignal?: RegExp;
  contentSignalHint?: string;
}

const SECTION_SPECS: SectionSpec[] = [
  {
    name: "experience",
    // Matches a header line that ends in "experience" (optionally preceded
    // by qualifying words like "Professional", "Work", or a domain like
    // "AI Engineering") as well as "employment/work history" variants.
    // Anchored to the end of the line, not the start, since real resumes
    // commonly qualify this header ("AI ENGINEERING EXPERIENCE", "RELEVANT
    // EXPERIENCE") rather than using the bare word alone.
    headerPattern: /experience\s*$|^\s{0,4}employment\s+history\s*$|^\s{0,4}work\s+history\s*$/i,
    minContentLines: 2,
    contentSignal: /\b(19|20)\d{2}\b/,
    contentSignalHint: "no dates found in the experience section",
  },
  {
    name: "education",
    headerPattern: /education\s*$|academic\s+background\s*$/i,
    minContentLines: 1,
  },
  {
    name: "skills",
    headerPattern: /skills\s*$|core\s+competencies\s*$/i,
    minContentLines: 1,
  },
  {
    name: "summary",
    headerPattern: /^\s{0,4}(professional\s+)?(summary|objective|profile)\s*$/i,
    minContentLines: 1,
  },
];

// A line is a plausible section header if it's short and doesn't itself
// look like body content (a long sentence, a bullet). This is a rough
// proxy for the layout signal (font size/boldness) a real parser would
// use, since plain extracted text has no typographic metadata.
function looksLikeHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return false;
  if (/^[•\-*]/.test(trimmed)) return false;
  const wordCount = trimmed.split(/\s+/).length;
  return wordCount <= 5;
}

function findSectionSpans(lines: string[]): Array<{ spec: SectionSpec; start: number; end: number }> {
  const headerIndices: Array<{ spec: SectionSpec; index: number }> = [];

  lines.forEach((line, i) => {
    if (!looksLikeHeaderLine(line)) return;
    for (const spec of SECTION_SPECS) {
      if (spec.headerPattern.test(line.trim())) {
        headerIndices.push({ spec, index: i });
        break;
      }
    }
  });

  // Sort by position so each section's span ends where the next
  // recognized header begins (or end of document for the last one).
  headerIndices.sort((a, b) => a.index - b.index);

  return headerIndices.map((h, i) => ({
    spec: h.spec,
    start: h.index + 1,
    end: i + 1 < headerIndices.length ? headerIndices[i + 1].index : lines.length,
  }));
}

function scoreSections(text: string): { score: number; notes: string[] } {
  const notes: string[] = [];
  const lines = text.split("\n");
  const spans = findSectionSpans(lines);
  const perSection = 25 / SECTION_SPECS.length;
  let score = 0;

  for (const spec of SECTION_SPECS) {
    const span = spans.find((s) => s.spec.name === spec.name);
    if (!span) {
      notes.push(`No clearly-labeled "${spec.name}" section header detected.`);
      continue;
    }

    const contentLines = lines.slice(span.start, span.end).filter((l) => l.trim().length > 0);
    if (contentLines.length < spec.minContentLines) {
      notes.push(`"${spec.name}" section header found, but little or no content follows it.`);
      score += perSection * 0.4; // header exists, but content is too thin for full credit
      continue;
    }

    if (spec.contentSignal && !contentLines.some((l) => spec.contentSignal!.test(l))) {
      notes.push(`"${spec.name}" section has content, but ${spec.contentSignalHint}.`);
      score += perSection * 0.7;
      continue;
    }

    score += perSection;
  }

  return { score: Math.round(score), notes };
}

// ---------------------------------------------------------------------
// Contact info
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Keyword coverage: saturating (diminishing-returns) frequency scoring
// against terms extracted from the target role, instead of boolean
// presence. This is the standard BM25-family fix for two problems at
// once: a resume that mentions a required term once now scores
// differently from one that never mentions it (v1 couldn't do this --
// presence was binary), and repeating a term doesn't linearly inflate
// the score (the standard defense against keyword stuffing).
//
// There's no job-description corpus here to compute real IDF from, so
// "specificity" is approximated structurally: a token that looks like a
// specific tool/technology/proper noun (contains a digit, a symbol like
// + or #, or is capitalized mid-phrase) is weighted higher than a plain
// lowercase word, which is more likely to be a generic/common term.
// ---------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "of", "in", "at", "to", "with", "role", "position", "job",
]);

function extractRoleKeywords(targetRole: string): string[] {
  return Array.from(
    new Set(
      targetRole
        .split(/[^a-zA-Z0-9+.#]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()))
    )
  );
}

function keywordSpecificityWeight(keyword: string): number {
  // Contains a digit or a symbol commonly found in tech/tool names
  // (C++, C#, Node.js) -- near-certainly a specific term, not a filler word.
  if (/[0-9+#]/.test(keyword)) return 1.5;
  // Mixed-case or all-caps mid-word (AWS, PyTorch) reads as a proper
  // noun/acronym rather than a generic descriptor.
  if (/[A-Z]/.test(keyword.slice(1)) || keyword === keyword.toUpperCase()) return 1.3;
  return 1.0;
}

// Diminishing-returns curve: the first occurrence of a term matters far
// more than the fifth. log-based saturation, capped, mirrors BM25's
// term-frequency saturation without requiring a full BM25 implementation.
function saturatingScore(count: number, cap = 4): number {
  if (count <= 0) return 0;
  return Math.min(1, Math.log(1 + count) / Math.log(1 + cap));
}

function scoreKeywordCoverage(text: string, targetRole: string | undefined): { score: number; notes: string[] } {
  if (!targetRole || !targetRole.trim()) {
    return { score: 25, notes: ["No target role provided -- keyword coverage not scored (full credit given)."] };
  }

  const keywords = extractRoleKeywords(targetRole);
  if (keywords.length === 0) {
    return { score: 25, notes: [] };
  }

  const lowerText = text.toLowerCase();
  let totalWeight = 0;
  let earnedWeight = 0;
  const missing: string[] = [];

  for (const kw of keywords) {
    const weight = keywordSpecificityWeight(kw);
    totalWeight += weight;

    // Phrase-boundary match, not raw substring -- "java" must not match
    // inside "javascript". Escape regex metacharacters in the keyword
    // itself (dates/symbols like C++ need literal matching).
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`, "gi");
    const matches = lowerText.match(pattern);
    const count = matches ? matches.length : 0;

    if (count === 0) missing.push(kw);
    earnedWeight += weight * saturatingScore(count);
  }

  const ratio = totalWeight > 0 ? earnedWeight / totalWeight : 0;
  const score = Math.round(ratio * 25);

  const notes: string[] = [];
  if (missing.length > 0) {
    notes.push(`Target role terms not found in resume text: ${missing.join(", ")}.`);
  }

  return { score, notes };
}

// ---------------------------------------------------------------------
// Content quality: NOT grounded in peer-reviewed research. This rewards
// conventionally well-written resumes (quantified achievements, strong
// action-verb bullet openers) per widely-repeated career-coaching/hiring
// practitioner consensus -- there is no published study connecting these
// patterns to actual interview or hire rates. Treat this as a style
// convention signal, not an authority on what makes someone hireable.
// ---------------------------------------------------------------------

const STRONG_ACTION_VERBS = [
  "led", "built", "designed", "architected", "launched", "shipped", "reduced", "increased",
  "automated", "optimized", "developed", "implemented", "created", "drove", "delivered",
  "improved", "cut", "grew", "scaled", "engineered", "directed", "founded", "established",
  "wrote", "ran", "deployed", "fixed", "migrated", "redesigned", "rebuilt", "extended",
];

const WEAK_BULLET_OPENERS = [
  /^responsible for\b/i,
  /^worked on\b/i,
  /^helped (with|to)\b/i,
  /^involved in\b/i,
  /^tasked with\b/i,
];

function getBulletLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[•\-*▪◦]\s*/.test(l) || /^\d+[.)]\s+/.test(l))
    .map((l) => l.replace(/^[•\-*▪◦]\s*/, "").replace(/^\d+[.)]\s+/, ""));
}

function scoreContentQuality(text: string): { score: number; notes: string[] } {
  const notes: string[] = [];
  const bullets = getBulletLines(text);

  if (bullets.length === 0) {
    notes.push("No bullet-point lines detected -- content-quality checks (quantified achievements, action verbs) were skipped.");
    return { score: 7, notes }; // neutral partial credit; absence of bullets isn't necessarily a flaw (plain-text extraction can lose bullet glyphs)
  }

  const quantifiedPattern = /\d+(\.\d+)?\s*(%|percent|x\b|k\b|m\b|million|billion|\$)|\$\s*\d/i;
  const quantifiedCount = bullets.filter((b) => quantifiedPattern.test(b)).length;
  const quantifiedRatio = quantifiedCount / bullets.length;

  const strongOpenerCount = bullets.filter((b) => {
    const firstWord = b.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "");
    return STRONG_ACTION_VERBS.includes(firstWord);
  }).length;
  const weakOpenerCount = bullets.filter((b) => WEAK_BULLET_OPENERS.some((p) => p.test(b))).length;

  let score = 0;
  score += Math.round(quantifiedRatio * 8); // up to 8 points for quantified-achievement density
  score += Math.round((strongOpenerCount / bullets.length) * 7); // up to 7 for strong action-verb openers

  if (weakOpenerCount > 0) {
    score = Math.max(0, score - weakOpenerCount);
    notes.push(`${weakOpenerCount} bullet(s) open with a passive phrase ("responsible for", "worked on") -- a specific action verb reads stronger to most reviewers.`);
  }

  if (quantifiedRatio < 0.2) {
    notes.push("Few bullets include a quantified result (a number, percentage, or dollar figure) -- quantified impact is a widely-cited convention for readability, not a formal ATS requirement.");
  }

  return { score: Math.max(0, Math.min(15, score)), notes };
}

// ---------------------------------------------------------------------

export function scoreResume(text: string, targetRole: string | undefined): ScoreBreakdown {
  const parseability = scoreParseability(text);
  const sections = scoreSections(text);
  const contact = scoreContactInfo(text);
  const keywords = scoreKeywordCoverage(text, targetRole);
  const contentQuality = scoreContentQuality(text);

  const rawSubtotal = sections.score + contact.score + keywords.score + contentQuality.score; // max 25+10+25+15 = 75
  // Parseability multiplies the rest of the score rather than being
  // summed independently: a resume that fundamentally didn't parse
  // shouldn't be able to reach a high total on the strength of other
  // categories computed from garbage-extracted text.
  const parseabilityMultiplier = parseability.score / 100;
  const gatedSubtotal = rawSubtotal * parseabilityMultiplier;

  // Parseability itself contributes up to 25 points directly (so a
  // perfectly clean resume with weak content still can't reach 100 on
  // structure alone -- content quality and keyword match matter too).
  const parseabilityPoints = (parseability.score / 100) * 25;

  const total = Math.round(gatedSubtotal + parseabilityPoints);

  return {
    total: Math.max(0, Math.min(100, total)),
    parseability: parseability.score,
    sectionCoverage: sections.score,
    keywordCoverage: keywords.score,
    contactInfo: contact.score,
    contentQuality: contentQuality.score,
    notes: [...parseability.notes, ...sections.notes, ...contact.notes, ...keywords.notes, ...contentQuality.notes],
  };
}
