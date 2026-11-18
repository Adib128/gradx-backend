export type TenantBranding = {
  countryEn?: string;
  countryAr?: string;
  ministryEn?: string;
  ministryAr?: string;
  universityId?: string;
  universityEn?: string;
  universityAr?: string;
  facultyId?: string;
  facultyEn?: string;
  facultyAr?: string;
  departmentEn?: string;
  departmentAr?: string;
  logoUrl?: string;
};

export const DEFAULT_TENANT_BRANDING: TenantBranding = {
  countryEn: 'Kingdom of Saudi Arabia',
  countryAr: 'المملكة العربية السعودية',
  ministryEn: 'Ministry of Education',
  ministryAr: 'وزارة التعليم',
  universityId: '',
  universityEn: '',
  universityAr: '',
  facultyId: '',
  facultyEn: '',
  facultyAr: '',
  departmentEn: '',
  departmentAr: '',
  logoUrl: '',
};

const STRING_KEYS: (keyof TenantBranding)[] = [
  'countryEn',
  'countryAr',
  'ministryEn',
  'ministryAr',
  'universityId',
  'universityEn',
  'universityAr',
  'facultyId',
  'facultyEn',
  'facultyAr',
  'departmentEn',
  'departmentAr',
  'logoUrl',
];

export function normalizeTenantBranding(value: unknown): TenantBranding {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const next: TenantBranding = { ...DEFAULT_TENANT_BRANDING };
  for (const key of STRING_KEYS) {
    const candidate = raw[key];
    if (candidate == null) continue;
    next[key] = String(candidate);
  }

  // Migrate legacy ministry labels.
  if (
    next.ministryEn === 'Ministry of Higher Education' ||
    !String(next.ministryEn || '').trim()
  ) {
    next.ministryEn = DEFAULT_TENANT_BRANDING.ministryEn;
  }
  if (
    next.ministryAr === 'وزارة التعليم العالي' ||
    !String(next.ministryAr || '').trim()
  ) {
    next.ministryAr = DEFAULT_TENANT_BRANDING.ministryAr;
  }
  if (!String(next.countryEn || '').trim()) {
    next.countryEn = DEFAULT_TENANT_BRANDING.countryEn;
  }
  if (!String(next.countryAr || '').trim()) {
    next.countryAr = DEFAULT_TENANT_BRANDING.countryAr;
  }

  return next;
}
