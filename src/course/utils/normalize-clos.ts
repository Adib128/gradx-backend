/**
 * Ensure CLO `code` is course-style (1.1, 2.1) and `programCLOCode` is
 * program alignment (K1, S1, V1). Fixes common extract swaps.
 */

const PLO_STYLE = /^[KSV]\d+$/i;
const COURSE_CLO_STYLE = /^\d+\.\d+$/;

function categoryPrefix(category: string) {
  const value = String(category || 'OTHER').toUpperCase();
  if (value === 'KNOWLEDGE') return '1';
  if (value === 'SKILLS') return '2';
  if (value === 'VALUES') return '3';
  return '4';
}

export type CloLike = {
  code?: string | null;
  category?: string | null;
  programCLOCode?: string | null;
  [key: string]: unknown;
};

export function normalizeClosForStorage<T extends CloLike>(
  clos: T[],
): { clos: T[]; codeRemap: Map<string, string> } {
  const categoryCounters = new Map<string, number>();
  const codeRemap = new Map<string, string>();

  const normalized = clos.map((clo, index) => {
    let code = String(clo.code ?? '').trim();
    let programCLOCode = String(clo.programCLOCode ?? '').trim();
    const originalCode = code;

    // Swapped fields: code=K1, programCLOCode=1.1
    if (PLO_STYLE.test(code) && COURSE_CLO_STYLE.test(programCLOCode)) {
      const swap = code;
      code = programCLOCode;
      programCLOCode = swap.toUpperCase();
    }

    // Alignment code wrongly stored in `code`, program empty
    if (PLO_STYLE.test(code) && !programCLOCode) {
      programCLOCode = code.toUpperCase();
      const category = String(clo.category || 'OTHER').toUpperCase();
      const next = (categoryCounters.get(category) ?? 0) + 1;
      categoryCounters.set(category, next);
      code = `${categoryPrefix(category)}.${next}`;
    }

    if (!code) {
      code = `CLO ${index + 1}`;
    }

    if (originalCode && originalCode !== code) {
      codeRemap.set(originalCode, code);
      codeRemap.set(originalCode.toUpperCase(), code);
    }
    if (programCLOCode && !codeRemap.has(programCLOCode)) {
      // Allow topic matrices that referenced PLO codes to remap to course CLO
      codeRemap.set(programCLOCode, code);
      codeRemap.set(programCLOCode.toUpperCase(), code);
    }

    return {
      ...clo,
      code,
      programCLOCode: programCLOCode || null,
    };
  });

  return { clos: normalized, codeRemap };
}

export function remapMappedClos(
  mappedClos: unknown,
  codeRemap: Map<string, string>,
): string[] {
  const list = Array.isArray(mappedClos) ? mappedClos : [];
  return list
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        return String(record.code ?? record.cloCode ?? '').trim();
      }
      return '';
    })
    .filter(Boolean)
    .map((code) => codeRemap.get(code) || codeRemap.get(code.toUpperCase()) || code);
}
