import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ApiProcess } from './main.js';
import { createProductionApiProcess } from './production.js';

const MAX_ERROR_BYTES = 1_024;

export interface ApiCliOptions {
  readonly create?: () => ApiProcess | Promise<ApiProcess>;
  readonly writeStdout?: (value: string) => void;
  readonly writeStderr?: (value: string) => void;
}

function boundedError(error: unknown): string {
  const raw = error instanceof Error && error.message.length > 0 ? error.message : String(error);
  const singleLine = raw.replace(/[\r\n\t]+/gu, ' ').trim() || 'unknown API failure';
  const prefix = 'API failed: ';
  const available = MAX_ERROR_BYTES - Buffer.byteLength(prefix, 'utf8') - 1;
  return `${prefix}${Buffer.from(singleLine, 'utf8').subarray(0, available).toString('utf8')}\n`;
}

export async function runApiCli(
  argv: readonly string[] = process.argv.slice(2),
  options: ApiCliOptions = {},
): Promise<number> {
  const writeStdout = options.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = options.writeStderr ?? ((value: string) => process.stderr.write(value));
  if (argv.length !== 0) {
    writeStderr('API accepts no command arguments\n');
    return 2;
  }
  try {
    const api = await (options.create ?? createProductionApiProcess)();
    const started = await api.start();
    writeStdout(`${JSON.stringify({
      available: true,
      port: started.port,
      freshnessSocketPath: started.freshnessSocketPath,
      blockers: started.startup.blockers.length,
    })}\n`);
    return 0;
  } catch (error) {
    writeStderr(boundedError(error));
    return 1;
  }
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  void runApiCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    process.stderr.write(boundedError(error));
    process.exitCode = 1;
  });
}
