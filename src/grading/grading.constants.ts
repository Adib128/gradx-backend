/** BullMQ queue for OpenCV / Node OMR work. */
export const GRADING_QUEUE = 'grading-opencv';

/**
 * Max concurrent OpenCV/Node grading jobs on this process.
 * Override with GRADING_QUEUE_CONCURRENCY (clamped 1–4). Default 2.
 */
export const GRADING_QUEUE_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.GRADING_QUEUE_CONCURRENCY || 2) || 2),
);

/** How long HTTP callers wait for a queued grade to finish. */
export const GRADING_JOB_WAIT_MS = 3 * 60 * 1000;
