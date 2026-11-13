import type { NodeGraderLayout } from './node-grader.service';
import type { OpenCvProcessResult } from './opencv-grading.service';

export type OpenCvGradingJob = {
  kind: 'opencv';
  imagePath: string;
  configJson?: string;
};

export type NodeGradingJob = {
  kind: 'node';
  imagePath: string;
  numIdDigits: number;
  layout?: NodeGraderLayout;
};

export type GradingJobData = OpenCvGradingJob | NodeGradingJob;

export type GradingJobResult = OpenCvProcessResult;
