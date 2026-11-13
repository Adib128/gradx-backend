import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { GradingQueueService } from './grading-queue.service';
import { GRADING_JOB_WAIT_MS, GRADING_QUEUE } from './grading.constants';
import type { GradingJobData } from './grading-job.types';

jest.mock('bullmq', () => {
  const actual = jest.requireActual('bullmq');
  return {
    ...actual,
    QueueEvents: jest.fn().mockImplementation(() => ({
      waitUntilReady: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

describe('GradingQueueService', () => {
  const result = {
    answers: { '1': 'A' },
    confidence: 0.95,
    decodedFormId: 2,
    detectedStudentId: '11111',
  };

  let queue: { add: jest.Mock };
  let waitUntilFinished: jest.Mock;
  let service: GradingQueueService;

  beforeEach(async () => {
    waitUntilFinished = jest.fn().mockResolvedValue(result);
    queue = {
      add: jest.fn().mockResolvedValue({
        id: 'job-9',
        waitUntilFinished,
      }),
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'REDIS_HOST') return '127.0.0.1';
        if (key === 'REDIS_PORT') return 6379;
        if (key === 'REDIS_PASSWORD') return 'secret';
        return undefined;
      }),
    } as unknown as ConfigService;

    service = new GradingQueueService(
      queue as unknown as Queue<GradingJobData>,
      config,
    );
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('creates QueueEvents for the grading queue on init', () => {
    expect(QueueEvents).toHaveBeenCalledWith(
      GRADING_QUEUE,
      expect.objectContaining({
        connection: expect.objectContaining({
          host: '127.0.0.1',
          port: 6379,
          password: 'secret',
          maxRetriesPerRequest: null,
        }),
      }),
    );
  });

  it('enqueues OpenCV work and waits for the same result shape', async () => {
    await expect(
      service.processAnswerSheet('/tmp/a.jpg', '{"mode":"idOnly"}'),
    ).resolves.toEqual(result);

    expect(queue.add).toHaveBeenCalledWith(
      'opencv',
      {
        kind: 'opencv',
        imagePath: '/tmp/a.jpg',
        configJson: '{"mode":"idOnly"}',
      },
      expect.objectContaining({
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 1,
      }),
    );
    expect(waitUntilFinished).toHaveBeenCalledWith(
      expect.anything(),
      GRADING_JOB_WAIT_MS,
    );
  });

  it('enqueues Node grader work and waits for the result', async () => {
    await expect(
      service.gradeSheet('/tmp/b.jpg', 10, { answerGrid: undefined }),
    ).resolves.toEqual(result);

    expect(queue.add).toHaveBeenCalledWith(
      'node',
      {
        kind: 'node',
        imagePath: '/tmp/b.jpg',
        numIdDigits: 10,
        layout: { answerGrid: undefined },
      },
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it('keeps HTTP sync semantics when the worker fails', async () => {
    waitUntilFinished.mockRejectedValue(new Error('job stalled'));
    await expect(
      service.processAnswerSheet('/tmp/c.jpg'),
    ).rejects.toThrow('job stalled');
  });
});
