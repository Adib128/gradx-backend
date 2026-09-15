/** Gregorian start year for a Hijri academic year. */
export function gregorianStartFromHijri(hijriYear: number): number {
  return Math.floor(hijriYear * 0.970224 + 621.5674);
}

/** Canonical: `1448 / 1449 (2026 / 2027)`. */
export function formatAcademicYearValue(hijriStart: number): string {
  const gregStart = gregorianStartFromHijri(hijriStart);
  return `${hijriStart} / ${hijriStart + 1} (${gregStart} / ${gregStart + 1})`;
}

export function legacyAcademicYearValue(hijriStart: number): string {
  const gregStart = gregorianStartFromHijri(hijriStart);
  return `${hijriStart}H (${gregStart}/${gregStart + 1})`;
}

export function parseAcademicYearHijriStart(
  value?: string | null,
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let match = trimmed.match(/^(\d{4})\s*\/\s*(\d{4})\s*\(/);
  if (match) return Number(match[1]);
  match = trimmed.match(/^(\d{4})\s*H?\b/i);
  if (match) return Number(match[1]);
  return null;
}

/** Values that should match the same academic year in the DB (new + legacy). */
export function academicYearMatchValues(value: string): string[] {
  const hijri = parseAcademicYearHijriStart(value);
  if (hijri == null) return [value];
  const gregStart = gregorianStartFromHijri(hijri);
  return Array.from(
    new Set([
      value,
      formatAcademicYearValue(hijri),
      legacyAcademicYearValue(hijri),
      `${hijri}H (${gregStart} / ${gregStart + 1})`,
    ]),
  );
}
