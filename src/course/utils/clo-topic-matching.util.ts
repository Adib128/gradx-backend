import { primitiveText } from './course-spec-fields.util';

export type MatchableClo = {
  code: string;
  description?: string | null;
  category?: string | null;
  programCLOCode?: string | null;
};

export type MatchableTopic = { title: string };

/** Upper bound of CLOs linked to one topic by automatic matching. */
const MAX_CLOS_PER_TOPIC = 3;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'these', 'those',
  'their', 'its', 'are', 'was', 'were', 'will', 'can', 'able', 'ability', 'use', 'using',
  'used', 'including', 'include', 'such', 'other', 'various', 'different', 'both', 'all',
  'any', 'each', 'via', 'per', 'among', 'between', 'within', 'about', 'how', 'what', 'when',
  'student', 'students', 'learner', 'learners', 'course', 'topic', 'topics', 'chapter',
  'unit', 'part', 'introduction', 'intro', 'overview', 'basic', 'basics', 'concept',
  'concepts', 'principle', 'principles', 'fundamental', 'fundamentals', 'related',
  'demonstrate', 'describe', 'explain', 'define', 'identify', 'recognize', 'understand',
  'understanding', 'apply', 'application', 'applications', 'analyze', 'analyse', 'evaluate',
  'develop', 'perform', 'show', 'state', 'list', 'outline', 'discuss', 'knowledge', 'skill',
  'skills', 'value', 'values', 'appropriate', 'effective', 'effectively', 'properly',
  'في', 'من', 'على', 'إلى', 'الى', 'عن', 'مع', 'أن', 'ان', 'التي', 'الذي', 'هذه', 'هذا',
  'الطالب', 'الطلاب', 'المقرر', 'مقدمة',
]);

const stem = (word: string) => {
  if (/^[a-z]+$/.test(word) && word.length > 5) {
    return word
      .replace(/(?:ations?|ments?|ness|ings?|ities|ity|ies|ed|es|s)$/, '')
      .replace(/e$/, '');
  }
  return word;
};

const tokensOf = (text: string | null | undefined): Set<string> =>
  new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
      .map(stem)
      .filter((word) => word.length >= 3),
  );

const similarity = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.sqrt(a.size * b.size);
};

const scoreMatrix = (clos: MatchableClo[], topics: MatchableTopic[]) => {
  const cloTokens = clos.map((clo) => tokensOf(`${clo.description ?? ''} ${clo.category ?? ''}`));
  return topics.map((topic) => {
    const topicTokens = tokensOf(topic.title);
    return cloTokens.map((tokens) => similarity(topicTokens, tokens));
  });
};

/** Maps CLO codes and unique program codes (e.g. "K1") to the CLO code. */
export function buildCloCodeResolver(clos: MatchableClo[]) {
  const byKey = new Map<string, string>();
  const normalize = (value: unknown) =>
    primitiveText(value).trim().toLowerCase().replace(/^clo\s*/, '');
  for (const clo of clos) {
    const code = String(clo.code ?? '').trim();
    if (code) byKey.set(normalize(code), code);
  }
  const programCounts = new Map<string, number>();
  for (const clo of clos) {
    const key = normalize(clo.programCLOCode);
    if (key) programCounts.set(key, (programCounts.get(key) ?? 0) + 1);
  }
  for (const clo of clos) {
    const key = normalize(clo.programCLOCode);
    const code = String(clo.code ?? '').trim();
    if (key && code && programCounts.get(key) === 1 && !byKey.has(key)) {
      byKey.set(key, code);
    }
  }
  return (value: unknown): string | null => byKey.get(normalize(value)) ?? null;
}

/**
 * Adds each CLO that no topic covers to the topic it fits best, so every CLO
 * appears at least once in the matrix.
 */
export function ensureCloCoverage(
  mappings: string[][],
  clos: MatchableClo[],
  topics: MatchableTopic[],
): string[][] {
  if (topics.length === 0) return mappings;
  const scores = scoreMatrix(clos, topics);
  const next = mappings.map((codes) => [...codes]);
  const covered = new Set(next.flat());
  clos.forEach((clo, cloIndex) => {
    if (covered.has(clo.code)) return;
    let best = -1;
    let bestScore = 0;
    scores.forEach((row, topicIndex) => {
      if (row[cloIndex] > bestScore) {
        bestScore = row[cloIndex];
        best = topicIndex;
      }
    });
    if (best < 0) {
      // No shared vocabulary: spread uncovered CLOs over the least-mapped topics.
      best = next.reduce(
        (minIndex, codes, index) => (codes.length < next[minIndex].length ? index : minIndex),
        0,
      );
    }
    next[best].push(clo.code);
    covered.add(clo.code);
  });
  return next;
}

/**
 * Deterministic topic → CLO matching by shared vocabulary. Topics with no
 * overlap are distributed across CLOs in order, so no topic is left empty.
 */
export function lexicalMatchClosToTopics(
  clos: MatchableClo[],
  topics: MatchableTopic[],
): string[][] {
  if (clos.length === 0) return topics.map(() => []);
  const scores = scoreMatrix(clos, topics);
  const mappings = scores.map((row, topicIndex) => {
    const best = Math.max(...row);
    if (best <= 0) {
      const spread = Math.floor((topicIndex * clos.length) / Math.max(topics.length, 1));
      return [clos[Math.min(spread, clos.length - 1)].code];
    }
    return row
      .map((score, cloIndex) => ({ score, code: clos[cloIndex].code }))
      .filter((item) => item.score >= best * 0.6)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CLOS_PER_TOPIC)
      .map((item) => item.code);
  });
  return ensureCloCoverage(mappings, clos, topics);
}

/**
 * Reads `{ mappings: [{ topic: 1, clos: ["1.1"] }] }` (1-based topic index)
 * into one code list per topic, keeping only known CLO codes.
 */
export function readAiCloTopicMappings(
  raw: unknown,
  clos: MatchableClo[],
  topicCount: number,
): string[][] {
  const resolve = buildCloCodeResolver(clos);
  const result: string[][] = Array.from({ length: topicCount }, () => []);
  const container = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rows = Array.isArray(container.mappings) ? container.mappings : [];
  rows.forEach((row, position) => {
    if (!row || typeof row !== 'object') return;
    const record = row as Record<string, unknown>;
    const topicNumber = Number(record.topic ?? record.topicIndex ?? record.index);
    const index =
      Number.isInteger(topicNumber) && topicNumber >= 1 && topicNumber <= topicCount
        ? topicNumber - 1
        : position;
    if (index < 0 || index >= topicCount) return;
    const values = Array.isArray(record.clos) ? record.clos : [];
    for (const value of values) {
      const code = resolve(value);
      if (code && !result[index].includes(code)) result[index].push(code);
    }
  });
  return result.map((codes) => codes.slice(0, MAX_CLOS_PER_TOPIC + 1));
}
