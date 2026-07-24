import { GenerateAssessmentDto } from '../dto/generate-assessment.dto';

export type AssessmentGenerationProgress = {
  stage: 'preparing' | 'generating' | 'parsing' | 'saving' | 'complete';
  percent: number;
  message: string;
  expectedQuestionCount?: number;
  savedQuestionCount?: number;
  partial?: {
    questions: unknown[];
  };
};

export type AssessmentGenerationJob = {
  tenantId: number;
  courseId: number;
  assessmentId: number;
  dto: GenerateAssessmentDto;
};
