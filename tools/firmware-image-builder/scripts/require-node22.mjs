const MINIMUM_MAJOR = 22;
const MINIMUM_MINOR = 5;

/**
 * Return a typed result so callers and tests can distinguish an unsupported
 * runtime from a process-level failure.
 *
 * @param {string} version
 * @returns {{ok: true} | {ok: false, errorCode: 'NODE_VERSION_UNSUPPORTED'}}
 */
export function checkNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    return { ok: false, errorCode: 'NODE_VERSION_UNSUPPORTED' };
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported = major > MINIMUM_MAJOR || (major === MINIMUM_MAJOR && minor >= MINIMUM_MINOR);
  return supported ? { ok: true } : { ok: false, errorCode: 'NODE_VERSION_UNSUPPORTED' };
}

const result = checkNodeVersion(process.version);
if (!result.ok) {
  console.error(`${result.errorCode}: Node.js >=22.5.0 is required; found ${process.version}`);
  process.exitCode = 1;
}
