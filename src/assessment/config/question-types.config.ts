import { QuestionType } from 'generated/prisma/enums';

export const ACTIVE_GENERATION_QUESTION_TYPES = [
  QuestionType.MCQ,
  QuestionType.TRUE_FALSE,
] as const;

export const HIDDEN_GENERATION_QUESTION_TYPES = [
  QuestionType.SHORT_ANSWER,
  QuestionType.CODING,
  QuestionType.MATH,
] as const;
