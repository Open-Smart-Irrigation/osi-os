'use strict';

const crypto = require('crypto');

function normalizeInstallationUuid(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)
    ? text
    : '';
}

function newInstallationUuid() {
  return crypto.randomUUID();
}

function normalizeGatewayDeviceEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (raw.length === 16) return raw === '0101010101010101' ? '' : raw;
  if (raw.length === 12) return raw.slice(0, 6) + 'FFFE' + raw.slice(6);
  return '';
}

function mergeGatewayHistory(currentValue, previousValues, nextValue) {
  const current = normalizeGatewayDeviceEui(currentValue);
  const next = normalizeGatewayDeviceEui(nextValue);
  if (!next) throw new Error('current gateway identity is required');
  const history = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(previousValues) ? previousValues : []), current]) {
    const normalized = normalizeGatewayDeviceEui(value);
    if (!normalized || normalized === next || seen.has(normalized)) continue;
    seen.add(normalized);
    history.push(normalized);
  }
  return {
    currentGatewayDeviceEui: next,
    previousGatewayDeviceEuis: history
  };
}

function verifierVersion(capabilities, installationUuid) {
  const supported = Array.isArray(capabilities) &&
    capabilities.some((value) => String(value || '').trim().toLowerCase() === 'installation_recovery_v1');
  return supported && normalizeInstallationUuid(installationUuid) ? 2 : 1;
}

function verifierSubject(password, version, installationUuid, gatewayDeviceEui) {
  const secret = String(password || '');
  if (Number(version) >= 2) {
    const normalizedInstallation = normalizeInstallationUuid(installationUuid);
    if (!normalizedInstallation) throw new Error('installation identity is required for verifier v2');
    return secret + '::' + normalizedInstallation;
  }
  const normalizedGateway = normalizeGatewayDeviceEui(gatewayDeviceEui);
  if (!normalizedGateway) throw new Error('gateway identity is required for verifier v1');
  return secret + '::' + normalizedGateway;
}

function assertMatchingInstallation(localValue, remoteValue) {
  const local = normalizeInstallationUuid(localValue);
  const remote = normalizeInstallationUuid(remoteValue);
  if (!local || !remote || local !== remote) {
    throw new Error('installation identity mismatch');
  }
  return local;
}

function canonicalWritesAllowed(recoveryState) {
  return String(recoveryState || '').trim().toUpperCase() === 'ACTIVE';
}

module.exports = {
  normalizeInstallationUuid,
  newInstallationUuid,
  normalizeGatewayDeviceEui,
  mergeGatewayHistory,
  verifierVersion,
  verifierSubject,
  assertMatchingInstallation,
  canonicalWritesAllowed
};
