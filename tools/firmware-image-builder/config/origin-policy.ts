const MAX_ORIGIN_BYTES = 4096;
export const CANONICAL_FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

export const EFFECTIVE_ORIGIN_CONFIG_COMMANDS = Object.freeze({
  urls: Object.freeze(['config', '--includes', '--null', '--get-all', 'remote.origin.url']),
  keys: Object.freeze(['config', '--includes', '--null', '--name-only', '--list']),
  fetchRefspecs: Object.freeze(['config', '--includes', '--null', '--get-all', 'remote.origin.fetch']),
});

export type OriginPolicyCode = 'ORIGIN_NOT_SSH' | 'ORIGIN_CONFIG_UNSAFE' | 'ORIGIN_REFSPEC_UNSAFE';

export class OriginPolicyError extends Error {
  readonly code: OriginPolicyCode;

  constructor(code: OriginPolicyCode) {
    super('The configured Git origin transport is not approved.');
    this.name = 'OriginPolicyError';
    this.code = code;
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
}

function reject(): never {
  throw new OriginPolicyError('ORIGIN_NOT_SSH');
}

function isValidSshUser(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function isValidSshHost(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.startsWith('-') || value.endsWith('-')) return false;
  const labels = value.split('.');
  return labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
}

function validateSshUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'ssh:' || parsed.hostname.length === 0 || parsed.password.length > 0 || parsed.pathname.length === 0 || parsed.pathname === '/' || parsed.search || parsed.hash) reject();
    if (parsed.username && !isValidSshUser(parsed.username)) reject();
    if (!isValidSshHost(parsed.hostname)) reject();
    if (parsed.port !== '' && (!/^\d+$/u.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535)) reject();
    if (parsed.pathname.startsWith('/-')) reject();
    return value;
  } catch {
    reject();
  }
}

function validateScpUrl(value: string): string {
  const match = /^([^@/:\\\s]+)@([^/:\\\s]+):(.+)$/u.exec(value);
  if (!match || !isValidSshUser(match[1]!) || !isValidSshHost(match[2]!) || match[3]!.startsWith('/') || match[3]!.startsWith('-')) reject();
  return value;
}

export function validateOriginUrl(value: unknown): string {
  if (typeof value !== 'string' || byteLength(value) === 0 || byteLength(value) > MAX_ORIGIN_BYTES || value.trim() !== value || /\s/u.test(value) || hasControl(value)) reject();
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)) reject();

  if (value.startsWith('ssh://')) return validateSshUrl(value);
  if (/^[^@/:\\\s]+@[^/:\\\s]+:[^\s]+$/u.test(value)) return validateScpUrl(value);
  reject();
}

export function parseNulValues(output: string, options: { readonly allowEmpty?: boolean; readonly maxBytes?: number } = {}): readonly string[] {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  if (byteLength(output) > maxBytes) throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
  if (output.length === 0 && options.allowEmpty) return Object.freeze([]);
  if (!output.endsWith('\0')) throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
  const values = output.slice(0, -1).split('\0');
  if (values.some((value) => value.length === 0 || hasControl(value))) throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
  return Object.freeze(values);
}

export function validateRepositoryConfigKeys(keys: readonly string[]): void {
  for (const key of keys) {
    if (byteLength(key) === 0 || byteLength(key) > 1024 || hasControl(key)) throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
    if (/^(?:include|includeif)(?:\.|$)/iu.test(key)) throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
    if (/^hook\./iu.test(key)) throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
    if (/^url\./iu.test(key)) throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
    if (/^(?:core\.(?:sshcommand|gitproxy|alternaterefscommand|alternaterefsprefixes|fsmonitor|askpass|pager|editor)|protocol\.|credential\.|(?:https?|ssh|proxy|transport)\.|uploadpack\.|receive\.)/iu.test(key)) throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
    if (/^submodule\.(?:recurse|[^.]+\.(?:url|update|fetchrecursesubmodules))$/iu.test(key)) throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
    if (/^fetch\.recurseSubmodules$/iu.test(key)) throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
    if (/^fetch\.bundle/iu.test(key)) throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
    if (/^remote\./iu.test(key) && key.toLowerCase() !== 'remote.origin.url' && key.toLowerCase() !== 'remote.origin.fetch') throw new OriginPolicyError('ORIGIN_CONFIG_UNSAFE');
  }
}

export function validateEffectiveOriginConfig(input: {
  readonly urls: readonly string[];
  readonly keys: readonly string[];
  readonly fetchRefspecs: readonly string[];
}): ValidatedOriginPolicy {
  validateRepositoryConfigKeys(input.keys);
  if (input.urls.length !== 1) throw new OriginPolicyError('ORIGIN_NOT_SSH');
  validateFetchRefspecs(input.fetchRefspecs);
  return Object.freeze({ url: validateOriginUrl(input.urls[0]), fetchRefspec: input.fetchRefspecs[0]! });
}

export function validateFetchRefspecs(refspecs: readonly string[]): void {
  if (refspecs.length !== 1 || refspecs[0] !== CANONICAL_FETCH_REFSPEC) throw new OriginPolicyError('ORIGIN_REFSPEC_UNSAFE');
}

export interface ValidatedOriginPolicy {
  readonly url: string;
  readonly fetchRefspec: string;
}

export function sameOriginPolicy(first: ValidatedOriginPolicy, second: ValidatedOriginPolicy): boolean {
  return first.url === second.url && first.fetchRefspec === second.fetchRefspec;
}
