describe('REFERENCE_EMBEDDING_QUEUE_CONCURRENCY', () => {
  const ORIGINAL = process.env.REFERENCE_EMBEDDING_QUEUE_CONCURRENCY;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.REFERENCE_EMBEDDING_QUEUE_CONCURRENCY;
    } else {
      process.env.REFERENCE_EMBEDDING_QUEUE_CONCURRENCY = ORIGINAL;
    }
    jest.resetModules();
  });

  it('defaults to 1', () => {
    delete process.env.REFERENCE_EMBEDDING_QUEUE_CONCURRENCY;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./reference-vector.constants');
    expect(mod.REFERENCE_EMBEDDING_QUEUE_CONCURRENCY).toBe(1);
  });

  it('clamps high values to 2', () => {
    process.env.REFERENCE_EMBEDDING_QUEUE_CONCURRENCY = '9';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require('./reference-vector.constants').REFERENCE_EMBEDDING_QUEUE_CONCURRENCY).toBe(
      2,
    );
  });

  it('treats 0 as default 1 and accepts 2', () => {
    process.env.REFERENCE_EMBEDDING_QUEUE_CONCURRENCY = '0';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require('./reference-vector.constants').REFERENCE_EMBEDDING_QUEUE_CONCURRENCY).toBe(
      1,
    );

    process.env.REFERENCE_EMBEDDING_QUEUE_CONCURRENCY = '2';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require('./reference-vector.constants').REFERENCE_EMBEDDING_QUEUE_CONCURRENCY).toBe(
      2,
    );
  });
});
