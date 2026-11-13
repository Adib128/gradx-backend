import { Job } from 'bullmq';
import { GradingProcessor } from './grading.processor';
import type { GradingJobData } from '../grading-job.types';
import type { OpenCvGradingService } from '../opencv-grading.service';
import type { NodeGraderService } from '../node-grader.service';

describe('GradingProcessor', () => {
  const openCvResult = {
    answers: { '1': 'A' },
    confidence: 0.9,
    decodedFormId: 1,
    detectedStudentId: '12345',
  };
  const nodeResult = {
    answers: { '1': 'B' },
    confidence: 0.7,
    decodedFormId: null,
    questionDetails: [],
    detectedStudentId: '67890',
    debug: {},
  };

  let openCvService: { processAnswerSheet: jest.Mock };
  let nodeGrader: { gradeSheet: jest.Mock };
  let processor: GradingProcessor;

  beforeEach(() => {
    openCvService = {
      processAnswerSheet: jest.fn().mockResolvedValue(openCvResult),
    };
    nodeGrader = {
      gradeSheet: jest.fn().mockResolvedValue(nodeResult),
    };
    processor = new GradingProcessor(
      openCvService as unknown as OpenCvGradingService,
      nodeGrader as unknown as NodeGraderService,
    );
  });

  it('runs OpenCV jobs through OpenCvGradingService', async () => {
    const job = {
      id: '1',
      data: {
        kind: 'opencv',
        imagePath: '/tmp/scan.jpg',
        configJson: '{"mode":"idOnly"}',
      },
    } as Job<GradingJobData>;

    await expect(processor.process(job)).resolves.toEqual(openCvResult);
    expect(openCvService.processAnswerSheet).toHaveBeenCalledWith(
      '/tmp/scan.jpg',
      '{"mode":"idOnly"}',
    );
    expect(nodeGrader.gradeSheet).not.toHaveBeenCalled();
  });

  it('runs Node jobs through NodeGraderService', async () => {
    const layout = { answerGrid: undefined, studentIdGrid: undefined };
    const job = {
      id: '2',
      data: {
        kind: 'node',
        imagePath: '/tmp/scan.jpg',
        numIdDigits: 9,
        layout,
      },
    } as Job<GradingJobData>;

    await expect(processor.process(job)).resolves.toEqual(nodeResult);
    expect(nodeGrader.gradeSheet).toHaveBeenCalledWith(
      '/tmp/scan.jpg',
      9,
      layout,
    );
    expect(openCvService.processAnswerSheet).not.toHaveBeenCalled();
  });

  it('propagates OpenCV failures so waitUntilFinished rejects', async () => {
    openCvService.processAnswerSheet.mockRejectedValue(
      new Error('OpenCV process failed with code 1'),
    );
    const job = {
      id: '3',
      data: { kind: 'opencv', imagePath: '/tmp/bad.jpg' },
    } as Job<GradingJobData>;

    await expect(processor.process(job)).rejects.toThrow(
      'OpenCV process failed with code 1',
    );
  });
});
