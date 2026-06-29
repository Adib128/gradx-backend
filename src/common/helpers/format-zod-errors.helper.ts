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

  return issues.map((issue) => ({
    field: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}
