-- MCQ may accept one or many correct options; partial credit when only some are marked.
ALTER TABLE "questions" ADD COLUMN IF NOT EXISTS "allowMultipleCorrect" BOOLEAN NOT NULL DEFAULT false;
