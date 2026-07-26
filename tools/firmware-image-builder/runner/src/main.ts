import { createPipeline, type PipelineInput, type PipelineResult } from './pipeline.js';

export interface RunnerArguments {
  readonly jobId: string;
  readonly runnerUnit: string;
  readonly owner: string;
  readonly leaseExpiresAt: string;
}

export interface RunnerBootstrap {
  readonly createPipelineInput: (args: RunnerArguments) => Promise<PipelineInput>;
}

export function parseRunnerArguments(argv: readonly string[]): RunnerArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('runner arguments must be --key value pairs');
    values.set(key.slice(2), value);
    index += 1;
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.length === 0) throw new Error(`runner argument --${key} is required`);
    return value;
  };
  return Object.freeze({ jobId: required('job-id'), runnerUnit: required('runner-unit'), owner: required('owner'), leaseExpiresAt: required('lease-expires-at') });
}

export async function runRunner(argv: readonly string[], bootstrap: RunnerBootstrap): Promise<PipelineResult> {
  const args = parseRunnerArguments(argv);
  const input = await bootstrap.createPipelineInput(args);
  return createPipeline(input).run();
}
