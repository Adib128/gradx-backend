const DIAGRAM_HEADERS = [
  /^(flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/,
  /^sequenceDiagram\b/,
  /^classDiagram\b/,
  /^stateDiagram(-v2)?\b/,
  /^erDiagram\b/,
  /^gantt\b/,
  /^pie\b/,
  /^mindmap\b/,
  /^timeline\b/,
  /^journey\b/,
  /^quadrantChart\b/,
];

const MAX_LINES = 40;

/**
 * Cheap server-side sanity check (the real parser needs a DOM). Returns the
 * problems found; an empty list means "probably renders".
 */
export function mermaidProblems(code: string | null | undefined): string[] {
  const source = String(code ?? '').trim();
  if (!source) return ['empty diagram'];
  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('%%'));
  const problems: string[] = [];

  if (!DIAGRAM_HEADERS.some((pattern) => pattern.test(lines[0] ?? ''))) {
    problems.push(`unknown or missing diagram header "${lines[0] ?? ''}"`);
  }
  if (lines.length > MAX_LINES) problems.push(`too long (${lines.length} lines)`);
  if (/<\/?[a-z][^>]*>/i.test(source.replace(/<br\s*\/?>/gi, ''))) {
    problems.push('contains HTML tags');
  }
  if (/```/.test(source)) problems.push('contains code fences');

  const pairs: Array<[string, string]> = [
    ['[', ']'],
    ['(', ')'],
    ['{', '}'],
  ];
  for (const [open, close] of pairs) {
    const opened = source.split(open).length - 1;
    const closed = source.split(close).length - 1;
    if (opened !== closed) problems.push(`unbalanced "${open}${close}"`);
  }
  const quotes = (source.match(/"/g) || []).length;
  if (quotes % 2 !== 0) problems.push('unbalanced quotes');

  return problems;
}
