export function normalizeExtractedText(raw: string): string {
  return raw
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    // Collapse spaced-out letters from PDF extractors: "G e n e r a l" → "General"
    .replace(/\b(?:[A-Za-z0-9]\s){2,}[A-Za-z0-9]\b/g, (match) =>
      match.replace(/\s+/g, ''),
    )
    // "G eneral", "mod e", "3r d"
    .replace(/\b([A-Za-z])\s([a-z]{2,})\b/g, '$1$2')
    .replace(/\b(\d)\s*([a-z]{1,3})\b/gi, (_, digit, rest) => `${digit}${rest}`)
    .replace(/\b([A-Za-z]{2,})\s([a-z])\b(?=[\s.,;:!?]|$)/g, '$1$2')
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n')
    .trim();
}
