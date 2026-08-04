import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const UNIT_NAMES = [
  'osi-image-builder.service',
  'osi-image-builder-runner@.service',
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
    expect(value(unit, 'Service', 'UMask')).toBe('0077');
    expect(value(unit, 'Service', 'KillMode')).toBe('control-group');
    expect(value(unit, 'Service', 'TimeoutStopSec')).toBe('20s');
    expect(installValues(unit)).toContain('default.target');
  });

  it('keeps runner instances independent from the API and default.target', async () => {
    const { text, unit } = await readUnit('osi-image-builder-runner@.service');
    const exec = execWords(unit);

    expect(text).not.toMatch(/(?:Requires|Requisite|Wants|BindsTo|PartOf|After|Before)=.*osi-image-builder\.service/u);
    expect(text).not.toMatch(/PartOf=/u);
    expect(unit.has('Install')).toBe(false);
    expect(value(unit, 'Service', 'KillMode')).toBe('control-group');
    expect(value(unit, 'Service', 'TimeoutStopSec')).toBe('15s');
    expect(value(unit, 'Service', 'KillSignal')).toBe('SIGUSR1');
    expect(value(unit, 'Service', 'Restart')).toBe('no');
    expect(values(unit, 'Service', 'ExecStart')).toHaveLength(1);
    expect(exec.slice(1)).toEqual(['%i']);
    expect(credentialDirectives(unit)).toEqual([]);
  });

  it('keeps only runner instances templated in installed unit files', async () => {
    const api = await readUnit('osi-image-builder.service');
    const runner = await readUnit('osi-image-builder-runner@.service');

    expect(execWords(api.unit).join(' ')).not.toContain('%i');
    expect(execWords(runner.unit).join(' ')).toContain('%i');
  });

  it('does not ship a static cleanup template that can bind the current version', async () => {
    await expect(access(new URL('osi-image-builder-cleanup@.service', unitDirectory))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
