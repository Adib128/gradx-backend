export const DIFFICULTY_PROFILES = [
  'BEGINNER',
  'EASY',
  'BALANCED',
  'MIXED',
  'ADVANCED',
  'EXPERT',
] as const;
export type DifficultyProfile = (typeof DIFFICULTY_PROFILES)[number];

export const QUESTION_DIFFICULTIES = ['Easy', 'Medium', 'Hard'] as const;
export type QuestionDifficulty = (typeof QUESTION_DIFFICULTIES)[number];

/** Easy / Medium / Hard percentages for each assessment-level profile. */
export const DIFFICULTY_DISTRIBUTION_PERCENTAGES: Record<
  DifficultyProfile,
  [number, number, number]
> = {
  BEGINNER: [80, 10, 10],
  EASY: [60, 20, 20],
  BALANCED: [20, 60, 20],
  MIXED: [33, 34, 33],
  ADVANCED: [20, 20, 60],
  EXPERT: [10, 10, 80],
};

export const DIFFICULTY_DISTRIBUTION_RULES: Record<DifficultyProfile, string> = {
  BEGINNER: '80% Easy, 10% Medium, 10% Hard questions',
  EASY: '60% Easy, 20% Medium, 20% Hard questions',
  BALANCED: '20% Easy, 60% Medium, 20% Hard questions',
  MIXED: '33% Easy, 34% Medium, 33% Hard questions',
  ADVANCED: '20% Easy, 20% Medium, 60% Hard questions',
  EXPERT: '10% Easy, 10% Medium, 80% Hard questions',
};

const resolveProfile = (
  difficulty?: string | null,
): DifficultyProfile => {
  const key = String(difficulty || 'BALANCED').trim().toUpperCase();
  return (DIFFICULTY_PROFILES as readonly string[]).includes(key)
    ? (key as DifficultyProfile)
    : 'BALANCED';
};

export const getDifficultyPercentages = (
  difficulty?: string | null,
): [number, number, number] =>
  DIFFICULTY_DISTRIBUTION_PERCENTAGES[resolveProfile(difficulty)];

/**
 * Helper to safely retrieve the textual distribution rules with a fallback
 */
export const getDifficultyRuleString = (difficulty?: string | null): string =>
  DIFFICULTY_DISTRIBUTION_RULES[resolveProfile(difficulty)];

export const normalizeQuestionDifficulty = (
  value?: string | null,
): QuestionDifficulty => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (
    normalized === 'easy' ||
    normalized === 'beginner' ||
    normalized === 'low'
  ) {
    return 'Easy';
  }
  if (
    normalized === 'hard' ||
    normalized === 'expert' ||
    normalized === 'advanced' ||
    normalized === 'difficult' ||
    normalized === 'high'
  ) {
    return 'Hard';
  }
  return 'Medium';
};

const largestRemainderCounts = (
  total: number,
  percents: [number, number, number],
): [number, number, number] => {
  if (total <= 0) return [0, 0, 0];
  const raw = percents.map((percent) => (percent / 100) * total);
  const floors = raw.map((value) => Math.floor(value)) as [
    number,
    number,
    number,
  ];
  let remaining = total - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; i < remaining; i += 1) {
    floors[order[i % order.length].index] += 1;
  }
  return floors;
};

const interleaveDifficulties = (
  counts: [number, number, number],
): QuestionDifficulty[] => {
  const queues = QUESTION_DIFFICULTIES.map((level, index) =>
    Array.from({ length: counts[index] }, () => level),
  );
  const allocated: QuestionDifficulty[] = [];
  while (queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) allocated.push(next);
    }
  }
  return allocated;
};

/**
 * Assign Easy/Medium/Hard to `count` new questions so the exam matches the
 * chosen profile. When existing labeled questions are passed, remaining slots
 * fill the shortfall against the same profile.
 */
export const allocateQuestionDifficulties = (
  count: number,
  profile?: string | null,
  existing: Array<string | null | undefined> = [],
): QuestionDifficulty[] => {
  if (count <= 0) return [];

  const percents = getDifficultyPercentages(profile);
  const knownExisting = existing
    .map((value) =>
      value == null || String(value).trim() === ''
        ? null
        : normalizeQuestionDifficulty(value),
    )
    .filter((value): value is QuestionDifficulty => Boolean(value));

  if (knownExisting.length === 0) {
    return interleaveDifficulties(largestRemainderCounts(count, percents));
  }

  const total = count + knownExisting.length;
  const target = largestRemainderCounts(total, percents);
  const have = [0, 0, 0] as [number, number, number];
  for (const level of knownExisting) {
    have[QUESTION_DIFFICULTIES.indexOf(level)] += 1;
  }

  const assigned = have.map((current, index) =>
    Math.max(0, target[index] - current),
  ) as [number, number, number];
  let leftover = count - assigned.reduce((sum, value) => sum + value, 0);

  if (leftover > 0) {
    const fillOrder = [0, 1, 2].sort(
      (a, b) => percents[b] - percents[a] || a - b,
    );
    let cursor = 0;
    while (leftover > 0) {
      assigned[fillOrder[cursor % fillOrder.length]] += 1;
      leftover -= 1;
      cursor += 1;
    }
  } else if (leftover < 0) {
    const drainOrder = [0, 1, 2].sort(
      (a, b) => assigned[b] - assigned[a] || percents[a] - percents[b],
    );
    let cursor = 0;
    while (leftover < 0 && assigned.some((value) => value > 0)) {
      const index = drainOrder[cursor % drainOrder.length];
      if (assigned[index] > 0) {
        assigned[index] -= 1;
        leftover += 1;
      }
      cursor += 1;
    }
  }

  return interleaveDifficulties(assigned);
};
