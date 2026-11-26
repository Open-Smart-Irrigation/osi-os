import type {Save} from './core/types';

interface ReplayFileTarget {
  build: string;
  session(): number;
  load(save: Save): void;
  fail(message: string): void;
}

export async function loadReplayFile(file: Pick<File, 'text'>, target: ReplayFileTarget) {
  const session = target.session();
  try {
    const text = await file.text();
    if (target.session() !== session) return;
    const save = JSON.parse(text) as Save;
    if (save.header.build !== target.build) throw new Error('This replay was made with a different game build.');
    target.load(save);
  } catch (error) {
    if (target.session() !== session) return;
    target.fail(error instanceof Error ? error.message : 'The replay could not be loaded.');
  }
}
