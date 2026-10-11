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

function parseLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(repairJsonEscapes(text));
    } catch {
      return undefined;
    }
  }
}

/** Parse a whole (non-streamed or finished) JSON object response. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const value = parseLenient(cleaned.slice(start, end + 1));
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
