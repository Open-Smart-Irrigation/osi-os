import { describe, expect, it } from 'vitest';

import { createTerminalVerification } from '../../runner/src/terminal-verification.js';

const STAGES = [
  'preflight',
  'source',
  'release-gates',
  'frontend',
  'target-setup',
  'feeds',
  'config',
  'build',
  'verify',
  'publish',
] as const;

function runningVerification() {
  return {
    jobId: 'job-1',
    observations: {
      stageEvidence: STAGES.map((stage, index) => ({
        stage,
        path: `${String(index).padStart(2, '0')}-${stage}.json`,
        outcome: index === STAGES.length - 1 ? 'running' : 'passed',
      })),
    },
  };
}

describe('terminal verification', () => {
  it('promotes only the running publish stage and binds its fixed evidence path', () => {
    const terminal = createTerminalVerification('job-1', runningVerification());

    expect(terminal.manifest.observations).toMatchObject({
      publishEvidence: { path: 'jobs/job-1/evidence/09-publish.json' },
      stageEvidence: [
        ...STAGES.slice(0, -1).map((stage, index) => ({
          stage,
          path: `${String(index).padStart(2, '0')}-${stage}.json`,
          outcome: 'passed',
        })),
        { stage: 'publish', path: '09-publish.json', outcome: 'passed' },
      ],
    });
    expect(JSON.parse(terminal.bytes)).toEqual(terminal.manifest);
  });

  it('returns an already-terminal verification unchanged', () => {
    const first = createTerminalVerification('job-1', runningVerification());
    const second = createTerminalVerification('job-1', first.manifest);

    expect(second).toEqual(first);
  });

  it('rejects a non-passed prerequisite stage', () => {
    const verification = runningVerification();
    verification.observations.stageEvidence[4]!.outcome = 'failed';

    expect(() => createTerminalVerification('job-1', verification))
      .toThrow(/non-passed prerequisite/i);
  });
});
