export interface CommandResult {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface FakeCommandExecutor {
  run(command: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<CommandResult>;
}

export interface FakeGitClient {
  fetch(remote: string): Promise<void>;
  resolveRemoteBranch(branch: string): Promise<string>;
  createDetachedWorktree(path: string, sha: string): Promise<void>;
}

export interface FakeDockerClient {
  start(containerName: string, args: readonly string[]): Promise<{ containerId: string }>;
  stop(containerId: string): Promise<void>;
  remove(containerId: string): Promise<void>;
  inspect(containerId: string): Promise<{ running: boolean; labels: Readonly<Record<string, string>> }>;
}

export interface FakeSystemdClient {
  start(unit: string): Promise<void>;
  stop(unit: string): Promise<void>;
  isActive(unit: string): Promise<boolean>;
}

export interface FakeClock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface FakeFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: Uint8Array | string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export interface FakePublisherClient {
  publish(stagingPath: string, releasePath: string): Promise<void>;
  quarantine(stagingPath: string, quarantinePath: string): Promise<void>;
}
