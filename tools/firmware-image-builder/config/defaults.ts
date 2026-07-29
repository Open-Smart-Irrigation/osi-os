import { homedir } from 'node:os';
import { resolve } from 'node:path';

export {
  DEFAULT_BUILDER_LOCK_FILE,
  DEFAULT_MAX_QUEUE_LENGTH,
  MIN_DISK_FREE_BYTES,
} from './config-document.mjs';

export const DEFAULT_REMOTE = 'origin' as const;

export interface ConfigDirectories {
  readonly configRoot: string;
  readonly stateRoot: string;
}

export function resolveConfigDirectories(env: NodeJS.ProcessEnv = process.env): ConfigDirectories {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : resolve(home, '.config');
  const stateHome = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
    ? env.XDG_STATE_HOME
    : resolve(home, '.local', 'state');

  return {
    configRoot: resolve(configHome, 'osi-image-builder'),
    stateRoot: resolve(stateHome, 'osi-image-builder'),
  };
}
