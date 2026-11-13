describe('GRADING_QUEUE_CONCURRENCY', () => {
  const ORIGINAL = process.env.GRADING_QUEUE_CONCURRENCY;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GRADING_QUEUE_CONCURRENCY;
    else process.env.GRADING_QUEUE_CONCURRENCY = ORIGINAL;
    jest.resetModules();
  });

  it('defaults to 2', () => {
    delete process.env.GRADING_QUEUE_CONCURRENCY;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./grading.constants') as typeof import('./grading.constants');
    expect(mod.GRADING_QUEUE_CONCURRENCY).toBe(2);
    expect(mod.GRADING_QUEUE).toBe('grading-opencv');
  });

  it('clamps env overrides between 1 and 4', () => {
    process.env.GRADING_QUEUE_CONCURRENCY = '9';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require('./grading.constants').GRADING_QUEUE_CONCURRENCY).toBe(4);

    // 0 / NaN fall back to the default 2, then clamp.
    process.env.GRADING_QUEUE_CONCURRENCY = '0';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require('./grading.constants').GRADING_QUEUE_CONCURRENCY).toBe(2);

    process.env.GRADING_QUEUE_CONCURRENCY = '1';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require('./grading.constants').GRADING_QUEUE_CONCURRENCY).toBe(1);
  });
});
