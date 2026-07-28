import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const UNIT_NAMES = [
  'osi-image-builder.service',
  'osi-image-builder-runner@.service',
  'osi-image-builder-cleanup@.service',
] as const;

type UnitName = (typeof UNIT_NAMES)[number];
type UnitSections = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;

const unitDirectory = new URL('../../systemd/', import.meta.url);

function parseUnit(contents: string): UnitSections {
  const sections = new Map<string, Map<string, string[]>>();
  let section = '';

  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    const equals = line.indexOf('=');
    if (equals < 1 || section.length === 0) continue;
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    const values = sections.get(section)!.get(key) ?? [];
    values.push(value);
    sections.get(section)!.set(key, values);
  }

  return sections;
}

async function readUnit(name: UnitName): Promise<{ readonly text: string; readonly unit: UnitSections }> {
  let text: string;
  try {
    text = await readFile(new URL(name, unitDirectory), 'utf8');
  } catch (error) {
    expect.fail(`systemd unit ${name} is missing: ${String(error)}`);
    throw error;
  }
  return { text, unit: parseUnit(text) };
}

function values(unit: UnitSections, section: string, key: string): readonly string[] {
  return unit.get(section)?.get(key) ?? [];
}

function value(unit: UnitSections, section: string, key: string): string | undefined {
  return values(unit, section, key)[0];
}

function execWords(unit: UnitSections): readonly string[] {
  const execStart = value(unit, 'Service', 'ExecStart');
  expect(execStart).toBeDefined();
  return execStart!.replace(/^-/u, '').split(/\s+/u);
}

function installValues(unit: UnitSections): readonly string[] {
  return [
    ...values(unit, 'Install', 'WantedBy'),
    ...values(unit, 'Install', 'RequiredBy'),
    ...values(unit, 'Install', 'Also'),
  ];
}

function credentialDirectives(unit: UnitSections): readonly string[] {
  return [
    ...values(unit, 'Service', 'EnvironmentFile'),
    ...values(unit, 'Service', 'PassEnvironment'),
    ...values(unit, 'Service', 'LoadCredential'),
    ...values(unit, 'Service', 'LoadCredentialEncrypted'),
    ...values(unit, 'Service', 'SetCredential'),
    ...values(unit, 'Service', 'SetCredentialEncrypted'),
    ...values(unit, 'Service', 'ImportCredential'),
  ];
}

describe('user systemd unit contracts', () => {
  it('ships the API unit as a loopback service wanted by default.target', async () => {
    const { unit } = await readUnit('osi-image-builder.service');
    const exec = execWords(unit);
    const environment = values(unit, 'Service', 'Environment');

    expect(exec[0]).toContain('osi-image-builder-api');
    expect(environment).toContain('OSI_IMAGE_BUILDER_BIND_ADDRESS=127.0.0.1');
    expect(environment).toContain('OSI_IMAGE_BUILDER_HOST=127.0.0.1');
    expect(installValues(unit)).toContain('default.target');
  });

  it('keeps runner instances independent from the API and default.target', async () => {
    const { text, unit } = await readUnit('osi-image-builder-runner@.service');

    expect(text).not.toMatch(/(?:Requires|Requisite|Wants|BindsTo|PartOf|After|Before)=.*osi-image-builder\.service/u);
    expect(text).not.toMatch(/PartOf=/u);
    expect(unit.has('Install')).toBe(false);
    expect(value(unit, 'Service', 'KillMode')).toBe('control-group');
    expect(value(unit, 'Service', 'TimeoutStopSec')).toBe('15s');
    expect(value(unit, 'Service', 'KillSignal')).toBe('SIGUSR1');
    expect(value(unit, 'Service', 'Restart')).toBe('no');
    expect(values(unit, 'Service', 'ExecStart')).toHaveLength(1);
    expect(credentialDirectives(unit)).toEqual([]);
  });

  it('starts cleanup only as a single-use API admission worker', async () => {
    const { text, unit } = await readUnit('osi-image-builder-cleanup@.service');
    const exec = execWords(unit);
    const environment = values(unit, 'Service', 'Environment').join('\n');
    const bindPaths = values(unit, 'Service', 'BindPaths');
    const bindReadOnlyPaths = values(unit, 'Service', 'BindReadOnlyPaths');
    const inaccessiblePaths = values(unit, 'Service', 'InaccessiblePaths');
    const execPaths = values(unit, 'Service', 'ExecPaths');

    expect(value(unit, 'Service', 'Type')).toBe('oneshot');
    expect(value(unit, 'Service', 'RemainAfterExit')).toBe('no');
    expect(value(unit, 'Service', 'KillMode')).toBe('control-group');
    expect(value(unit, 'Service', 'Restart')).toBe('no');
    expect(value(unit, 'Service', 'NoNewPrivileges')).toBe('yes');
    expect(value(unit, 'Service', 'PrivateTmp')).toBe('yes');
    expect(value(unit, 'Service', 'ProtectSystem')).toBe('strict');
    expect(value(unit, 'Service', 'ProtectHome')).toBe('tmpfs');

    expect(values(unit, 'Service', 'ExecStart')).toHaveLength(1);
    expect(exec.slice(1)).toEqual(['%i']);
    expect(exec.filter((word) => /%[iI]/u.test(word))).toEqual(['%i']);
    expect(exec.join(' ')).not.toMatch(/(?:job[_-]?id|token|credential)/iu);
    expect(environment).not.toMatch(/(?:job[_-]?id|token|credential)/iu);
    expect(credentialDirectives(unit)).toEqual([]);
    expect(unit.has('Install')).toBe(false);

    expect(values(unit, 'Service', 'Environment')).toEqual([
      'XDG_CONFIG_HOME=@OSI_IMAGE_BUILDER_XDG_CONFIG_HOME@',
      'XDG_STATE_HOME=@OSI_IMAGE_BUILDER_XDG_STATE_HOME@',
    ]);
    expect(values(unit, 'Service', 'StateDirectory')).toEqual([]);
    expect(bindPaths).toEqual([
      '@OSI_IMAGE_BUILDER_STATE_ROOT@',
      '@OSI_IMAGE_BUILDER_OUTPUT_WORK_ROOT_PATHS@',
    ]);
    expect(bindReadOnlyPaths).toEqual([
      '@OSI_IMAGE_BUILDER_VERSIONED_INSTALL_ROOT@',
      '@OSI_IMAGE_BUILDER_CONFIG_ROOT@',
      '@OSI_IMAGE_BUILDER_OUTPUT_ROOT_PATHS@',
    ]);
    expect(inaccessiblePaths).toEqual(['@OSI_IMAGE_BUILDER_REPOSITORY_PATH@']);
    expect(values(unit, 'Service', 'ReadWritePaths')).toEqual([]);
    expect(values(unit, 'Service', 'ReadOnlyPaths')).toEqual([]);
    expect(values(unit, 'Service', 'NoExecPaths')).toEqual(['/']);
    expect(execPaths).toEqual([
      '@OSI_IMAGE_BUILDER_VERSIONED_INSTALL_ROOT@/bin/osi-image-builder-cleanup',
      '@OSI_IMAGE_BUILDER_VERSIONED_INSTALL_ROOT@/bin/osi-image-publish',
      '/usr/bin/node',
      '/usr/bin/systemctl',
      '/usr/bin/docker',
    ]);
    expect(exec[0]).toBe('@OSI_IMAGE_BUILDER_VERSIONED_INSTALL_ROOT@/bin/osi-image-builder-cleanup');
    expect(text).not.toMatch(/^Exec(?:StartPre|StartPost|Reload|Stop|StopPost)=/mu);
  });

  it('keeps the three service names templated only where their lifecycle requires it', async () => {
    const api = await readUnit('osi-image-builder.service');
    const runner = await readUnit('osi-image-builder-runner@.service');
    const cleanup = await readUnit('osi-image-builder-cleanup@.service');

    expect(execWords(api.unit).join(' ')).not.toContain('%i');
    expect(execWords(runner.unit).join(' ')).toContain('%i');
    expect(execWords(cleanup.unit).slice(1)).toEqual(['%i']);
  });

  it('does not expose cleanup admission data through service environment', async () => {
    const { unit } = await readUnit('osi-image-builder-cleanup@.service');
    const environment = values(unit, 'Service', 'Environment');

    expect(environment).not.toContain(expect.stringMatching(/JOB_ID|ADMISSION_TOKEN|CLEANUP_TOKEN/u));
    expect(credentialDirectives(unit)).toEqual([]);
  });
});
