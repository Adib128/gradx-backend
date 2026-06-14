import { DifficultyDistribution } from 'generated/prisma/enums';

export const DIFFICULTY_DISTRIBUTION_RULES: Record<
  DifficultyDistribution,
  string
> = {
  [DifficultyDistribution.BEGINNER]: '80% Easy, 10% Medium, 10% Hard questions',
  [DifficultyDistribution.EASY]: '60% Easy, 20% Medium, 20% Hard questions',
  [DifficultyDistribution.BALANCED]: '20% Easy, 60% Medium, 20% Hard questions',
  [DifficultyDistribution.MIXED]: '33% Easy, 34% Medium, 33% Hard questions',
  [DifficultyDistribution.ADVANCED]: '20% Easy, 20% Medium, 60% Hard questions',
  [DifficultyDistribution.EXPERT]: '10% Easy, 10% Medium, 80% Hard questions',
};

/**
 * Helper to safely retrieve the textual distribution rules with a fallback
 */
export const getDifficultyRuleString = (
  difficulty?: DifficultyDistribution | null,
): string => {
  if (!difficulty)
    return DIFFICULTY_DISTRIBUTION_RULES[DifficultyDistribution.BALANCED];
  return (
    DIFFICULTY_DISTRIBUTION_RULES[difficulty] ??
    DIFFICULTY_DISTRIBUTION_RULES[DifficultyDistribution.BALANCED]
  );
};
