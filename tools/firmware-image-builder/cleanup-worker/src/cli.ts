import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCleanupWorker } from './production.js';
import { validateCleanupWorkerArgv, type CleanupWorkerResult } from './main.js';

const MAX_ERROR_BYTES = 1_024;

export interface CleanupWorkerCliOptions {
  readonly run?: (argv: readonly string[]) => Promise<CleanupWorkerResult>;
  readonly writeStderr?: (text: string) => void;
}

function errorText(error: unknown): string {
  const raw = error instanceof Error && error.message.length > 0 ? error.message : String(error);
  const singleLine = raw.replace(/[\r\n\t]+/gu, ' ');
  const bounded = Buffer.from(singleLine, 'utf8').subarray(0, MAX_ERROR_BYTES).toString('utf8');
  return bounded.length > 0 ? bounded : 'unknown cleanup worker failure';
}

export async function runCleanupWorkerCli(
  argv: readonly string[] = process.argv.slice(2),
  options: CleanupWorkerCliOptions = {},
): Promise<number> {
  const run = options.run ?? ((args: readonly string[]) => runCleanupWorker(args));
  const writeStderr = options.writeStderr ?? ((text: string) => process.stderr.write(text));
  try {
    const result = await run([validateCleanupWorkerArgv(argv)]);
    if (process.env.OSI_ADMITTED_CLEANUP_SHA256 !== undefined) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    return 0;
  } catch (error) {
    writeStderr(`cleanup worker failed: ${errorText(error)}\n`);
    return 1;
  }
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  void runCleanupWorkerCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    process.stderr.write(`cleanup worker failed: ${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
