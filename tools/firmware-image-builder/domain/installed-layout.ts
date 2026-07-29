import { isAbsolute, join } from 'node:path';

export const INSTALLED_BUILDER_LOCK_NAME = 'builder.lock.json';
export const INSTALLED_BUILDER_LOCK_MODE = 0o600;

export function installedMigrationsDirectory(builderLockPath: string): string {
  if (!isAbsolute(builderLockPath)) throw new Error('installed builder lock path must be absolute');
  if (!builderLockPath.endsWith(`/${INSTALLED_BUILDER_LOCK_NAME}`)) {
    throw new Error('installed builder lock path has an invalid filename');
  }
  return join(builderLockPath, '..', 'api', 'migrations');
}
