import type {Save} from './core/types';

interface ReplayFileTarget {
  build: string;
  session(): number;
  load(save: Save): void;
  fail(message: string): void;
}

export function createReplayFileLoader(target: ReplayFileTarget) {
  let latestSelection = 0;
  return async (file: Pick<File, 'text'>) => {
    const selection = ++latestSelection;
    const session = target.session();
    const isCurrent = () => selection === latestSelection && session === target.session();
    try {
      const text = await file.text();
      if (!isCurrent()) return;
      const save = JSON.parse(text) as Save;
      if (save.header.build !== target.build) throw new Error('This replay was made with a different game build.');
      target.load(save);
    } catch (error) {
      if (!isCurrent()) return;
      target.fail(error instanceof Error ? error.message : 'The replay could not be loaded.');
    }
  };
}
