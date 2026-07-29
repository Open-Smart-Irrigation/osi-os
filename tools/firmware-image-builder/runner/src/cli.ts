import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runRunner } from './main.js';
import type { PipelineResult } from './pipeline.js';

const MAX_ERROR_BYTES = 1_024;

export interface RunnerCliOptions {
  readonly run?: (argv: readonly string[]) => Promise<PipelineResult>;
  readonly writeStderr?: (value: string) => void;
}

function boundedError(error: unknown): string {
  const raw = error instanceof Error && error.message.length > 0 ? error.message : String(error);
  const singleLine = raw.replace(/[\r\n\t]+/gu, ' ').trim() || 'unknown runner failure';
  const prefix = 'runner failed: ';
  const available = MAX_ERROR_BYTES - Buffer.byteLength(prefix, 'utf8') - 1;
  return `${prefix}${Buffer.from(singleLine, 'utf8').subarray(0, available).toString('utf8')}\n`;
}

export async function runRunnerCli(
  argv: readonly string[] = process.argv.slice(2),
  options: RunnerCliOptions = {},
): Promise<number> {
  const execute = options.run ?? runRunner;
  const writeStderr = options.writeStderr ?? ((value: string) => process.stderr.write(value));
  try {
    const result = await execute(argv);
    return result.state === 'succeeded' || result.state === 'cancelled' ? 0 : 1;
  } catch (error) {
    writeStderr(boundedError(error));
    return 1;
  }
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  void runRunnerCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    process.stderr.write(boundedError(error));
    process.exitCode = 1;
  });
}
