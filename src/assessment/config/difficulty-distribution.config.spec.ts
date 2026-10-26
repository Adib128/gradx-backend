import {
  allocateQuestionDifficulties,
  getDifficultyPercentages,
  normalizeQuestionDifficulty,
} from './difficulty-distribution.config';

describe('allocateQuestionDifficulties', () => {
  it('matches Balanced 20/60/20 on five questions', () => {
    const allocated = allocateQuestionDifficulties(5, 'BALANCED');
    expect(allocated).toHaveLength(5);
    expect(allocated.filter((d) => d === 'Easy')).toHaveLength(1);
    expect(allocated.filter((d) => d === 'Medium')).toHaveLength(3);
    expect(allocated.filter((d) => d === 'Hard')).toHaveLength(1);
  });

  it('matches Expert 10/10/80 on ten questions', () => {
    const allocated = allocateQuestionDifficulties(10, 'EXPERT');
    expect(allocated.filter((d) => d === 'Easy')).toHaveLength(1);
    expect(allocated.filter((d) => d === 'Medium')).toHaveLength(1);
    expect(allocated.filter((d) => d === 'Hard')).toHaveLength(8);
  });

  it('fills the remaining mix when appending to existing questions', () => {
    const allocated = allocateQuestionDifficulties(
      2,
      'BALANCED',
      ['Easy', 'Medium', 'Medium'],
    );
    expect(allocated).toHaveLength(2);
    expect(allocated.sort()).toEqual(['Hard', 'Medium']);
  });

  it('normalizes profile labels and question bands', () => {
    expect(getDifficultyPercentages('balanced')).toEqual([20, 60, 20]);
    expect(normalizeQuestionDifficulty('Balanced')).toBe('Medium');
    expect(normalizeQuestionDifficulty('HARD')).toBe('Hard');
  });
});
