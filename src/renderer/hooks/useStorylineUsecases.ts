import { useMemo } from 'react';
import { StorylineUsecases } from '../usecase/storyline';
import { StorylineSQLiteRepository } from '../repositories/storyline_sqlite';

export function useStorylineUsecases() {
  const usecases = useMemo(() => {
    const repo = new StorylineSQLiteRepository();
    return new StorylineUsecases(repo);
  }, []);

  return usecases;
}
