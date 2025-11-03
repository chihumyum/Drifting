import { useMemo } from 'react';
import { StoryThreadUsecases } from '../usecase/story_thread';
import { StoryThreadSQLiteRepository } from '../repositories/story_thread_sqlite';

export function useStoryThreadUsecases() {
  const usecases = useMemo(() => {
    const repo = new StoryThreadSQLiteRepository();
    return new StoryThreadUsecases(repo);
  }, []);

  return usecases;
}
