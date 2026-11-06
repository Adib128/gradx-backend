/**
 * Incrementally extracts JSON objects from a streamed model response that is
 * meant to be NDJSON (one object per line). Tolerates code fences, array
 * brackets, trailing commas and objects pretty-printed across several lines.
 */
export class NdjsonStreamParser {
  private buffer = '';
  private pending = '';

  constructor(private readonly onObject: (value: Record<string, unknown>) => void) {}

  push(delta: string) {
    this.buffer += delta;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.consume(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  /** Flush the trailing line once the stream has ended. */
  end() {
    if (this.buffer) this.consume(this.buffer);
    this.buffer = '';
    if (this.pending.trim()) this.tryEmit(this.pending, true);
    this.pending = '';
  }

  private consume(rawLine: string) {
    const line = rawLine.trim();
    if (!line || line.startsWith('```') || line === '[' || line === ']') return;
    this.pending = this.pending ? `${this.pending}\n${line}` : line;
    this.tryEmit(this.pending, false);
  }

  private tryEmit(text: string, final: boolean) {
    const candidate = text
      .trim()
      .replace(/^\[/, '')
      .replace(/,\s*$/, '')
      .replace(/\]\s*$/, '')
      .trim();
    if (!candidate.startsWith('{')) {
      if (final || !candidate) this.pending = '';
      else if (!candidate.includes('{')) this.pending = '';
      return;
    }
    const value = parseLenient(candidate);
    if (value === undefined) {
      // Multi-line object still incomplete; keep accumulating (bounded).
      if (final || this.pending.length > 60_000) this.pending = '';
      return;
    }
    this.pending = '';
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      this.onObject(value as Record<string, unknown>);
    }
  }
}

/** LaTeX like `\alpha` arrives single-escaped; double stray backslashes. */
function repairJsonEscapes(text: string) {
  return text.replace(/\\(?!["\\/nru])/g, '\\\\');
}

/** Models often emit trailing commas before } or ]. */
function stripTrailingCommas(text: string) {
  return text.replace(/,\s*([}\]])/g, '$1');
}

function parseLenient(text: string): unknown {
  const attempts = [text, repairJsonEscapes(text), stripTrailingCommas(text), stripTrailingCommas(repairJsonEscapes(text))];
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Close truncated `{...` / `[...` payloads from short-output models. */
function closeTruncatedJson(text: string) {
  let repaired = text.replace(/,\s*$/, '');
  let depthObj = 0;
  let depthArr = 0;
  let inString = false;
  let escape = false;
  for (const ch of repaired) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depthObj += 1;
    else if (ch === '}') depthObj -= 1;
    else if (ch === '[') depthArr += 1;
    else if (ch === ']') depthArr -= 1;
  }
  if (inString) repaired += '"';
  while (depthArr > 0) {
    repaired += ']';
    depthArr -= 1;
  }
  while (depthObj > 0) {
    repaired += '}';
    depthObj -= 1;
  }
  return repaired;
}

/** Parse a whole (non-streamed or finished) JSON object response. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  const end = cleaned.lastIndexOf('}');
  const slice = end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start);
  for (const candidate of [slice, closeTruncatedJson(slice)]) {
    const value = parseLenient(candidate);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}
