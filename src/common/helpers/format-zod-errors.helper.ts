import { ZodIssue } from 'zod';

export interface FormattedValidationError {
  field: string;
  message: string;
  code?: string;
}

export function formatZodIssues(
  issues: ZodIssue[] | undefined,
): FormattedValidationError[] {
  if (!issues?.length) return [];

  return issues.flatMap((issue) => {
    if (!issue || typeof issue !== 'object') return [];
    const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : '';
    const message =
      typeof issue.message === 'string' && issue.message.trim()
        ? issue.message
        : 'Invalid value';
    return [
      {
        field: path,
        message,
        code: typeof issue.code === 'string' ? issue.code : undefined,
      },
    ];
  });
}
