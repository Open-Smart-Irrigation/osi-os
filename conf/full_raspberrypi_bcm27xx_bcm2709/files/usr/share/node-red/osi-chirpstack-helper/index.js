'use strict';

const crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const deviceGrpc = require('@chirpstack/chirpstack-api/api/device_grpc_pb');
const devicePb = require('@chirpstack/chirpstack-api/api/device_pb');
const applicationGrpc = require('@chirpstack/chirpstack-api/api/application_grpc_pb');
const applicationPb = require('@chirpstack/chirpstack-api/api/application_pb');
const tenantGrpc = require('@chirpstack/chirpstack-api/api/tenant_grpc_pb');
const tenantPb = require('@chirpstack/chirpstack-api/api/tenant_pb');
const profileGrpc = require('@chirpstack/chirpstack-api/api/device_profile_grpc_pb');
const profilePb = require('@chirpstack/chirpstack-api/api/device_profile_pb');
const gatewayGrpc = require('@chirpstack/chirpstack-api/api/gateway_grpc_pb');
const gatewayPb = require('@chirpstack/chirpstack-api/api/gateway_pb');
const commonPb = require('@chirpstack/chirpstack-api/common/common_pb');

const DEFAULT_PAGE_SIZE = 100;

// Shipped, fixed unary RPC deadline. Not configurable by caller/env/UCI.
const DEFAULT_RPC_TIMEOUT_MS = 10000;

// Allowlisted operation-step labels that may appear on a bounded error.
// Any step outside this set is normalized to 'grpc_call' before it can
// cross the helper boundary.
const OPERATION_STEPS = new Set([
  'validate',
  'getDevice',
  'createDevice',
  'updateDevice',
  'deleteDevice',
  'verifyDevice',
  'restoreDevice',
  'getKeys',
  'createKeys',
  'updateKeys',
  'deleteKeys',
  'verifyKeys',
  'restoreKeys',
  'ensureDeviceProvisioned',
  'listTenants',
  'createTenant',
  'listApplications',
  'createApplication',
  'listDeviceProfiles',
  'getDeviceProfile',
  'createDeviceProfile',
  'updateDeviceProfile',
  'getGateway',
  'updateGatewayLocation',
  'flushDeviceQueue',
  'close',
  'grpc_call',
]);

// Allowlisted gRPC status names (bidirectional grpc.status has numeric
// aliases too; keep only the name keys).
const GRPC_STATUS_NAMES = new Set(
  Object.keys(grpc.status).filter((key) => !/^\d+$/.test(key))
);

// Non-gRPC bounded result codes this helper may also return.
const EXTRA_RESULT_CODES = new Set(['RECONCILIATION_REQUIRED', 'CLOSE_FAILED']);

const RESULT_CODE_ALLOWLIST = new Set([...GRPC_STATUS_NAMES, ...EXTRA_RESULT_CODES]);

const SERVICE_ROLES = [
  'deviceClient',
  'applicationClient',
  'tenantClient',
  'deviceProfileClient',
  'gatewayClient',
];

function withDefault(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : value;
}

function normalizeDevEui(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeHexKey(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeApiUrl(apiUrl) {
  const raw = String(apiUrl || '').trim();
  if (!raw) {
    throw new Error('CHIRPSTACK_API_URL is required');
  }
  const normalized = raw.includes('://') ? raw : `http://${raw}`;
  const parsed = new URL(normalized);
  const secure = parsed.protocol === 'https:';
  const port = parsed.port || (secure ? '443' : '80');
  return {
    raw,
    parsed,
    target: `${parsed.hostname}:${port}`,
    secure
  };
}

function createMetadata(apiKey) {
  const token = String(apiKey || '').trim();
  if (!token) {
    throw new Error('CHIRPSTACK_API_KEY is required');
  }
  const metadata = new grpc.Metadata();
  metadata.set('authorization', `Bearer ${token}`);
  return metadata;
}

function createCredentials(normalizedUrl) {
  return normalizedUrl.secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
}

function grpcStatusName(code) {
  if (code === null || code === undefined) {
    return 'UNKNOWN';
  }
  for (const [name, value] of Object.entries(grpc.status)) {
    if (/^\d+$/.test(name)) continue;
    if (value === code) return name;
  }
  return 'UNKNOWN';
}

function normalizeStep(step) {
  return OPERATION_STEPS.has(step) ? step : 'grpc_call';
}

function normalizeResultCode(code) {
  return RESULT_CODE_ALLOWLIST.has(code) ? code : 'UNKNOWN';
}

// Constructs the ONLY error shape this helper ever surfaces across its
// boundary: a step from the reviewed allowlist and a normalized result
// code. Never copies message/details/metadata/cause/stack from a source
// exception, and never carries key material.
function boundedError(step, code) {
  const error = new Error('chirpstack_helper_bounded_error');
  error.step = normalizeStep(step);
  error.code = normalizeResultCode(code);
  return error;
}

function toGrpcError(error, step) {
  const rawCode = error && Number.isFinite(error.code) ? error.code : null;
  const codeName = rawCode === null ? 'UNKNOWN' : grpcStatusName(rawCode);
  return boundedError(step, codeName);
}

function reconciliationRequiredError(step, resourceKind) {
  const error = boundedError(step, 'RECONCILIATION_REQUIRED');
  error.resourceKind = resourceKind;
  return error;
}

function grpcInvoke(client, methodName, request, metadata, step) {
  return new Promise((resolve, reject) => {
    client[methodName](
      request,
      metadata,
      { deadline: new Date(Date.now() + DEFAULT_RPC_TIMEOUT_MS) },
      (error, response) => {
        if (error) {
          reject(toGrpcError(error, step || methodName));
          return;
        }
        resolve(response);
      }
    );
  });
}

function distinctNamedClients(instance) {
  const seen = new Set();
  const result = [];
  for (const role of SERVICE_ROLES) {
    const client = instance[role];
    if (client && !seen.has(client)) {
      seen.add(client);
      result.push([role, client]);
    }
  }
  return result;
}

async function paginate(buildRequest, call, listGetter) {
  const items = [];
  let offset = 0;
  while (true) {
    const request = buildRequest(DEFAULT_PAGE_SIZE, offset);
    const response = await call(request);
    const batch = response[listGetter]();
    items.push(...batch);
    if (batch.length < DEFAULT_PAGE_SIZE) {
      break;
    }
    offset += batch.length;
  }
  return items;
}

function listItemToObject(item) {
  return item && typeof item.toObject === 'function' ? item.toObject() : item;
}

function buildDeviceProfileMessage(input) {
  const regionName = String(input.region || 'EU868').trim().toUpperCase();
  const profile = new profilePb.DeviceProfile();
  const payloadCodecScript = input.payloadCodecScript === undefined || input.payloadCodecScript === null
    ? ''
    : String(input.payloadCodecScript);
  const hasPayloadCodec = payloadCodecScript.trim().length > 0;

  if (input.id) {
    profile.setId(String(input.id).trim());
  }
  profile.setTenantId(String(input.tenantId || '').trim());
  profile.setName(String(input.name || '').trim());
  profile.setDescription(String(withDefault(input.description, '')));
  profile.setRegion(commonPb.Region[regionName] ?? commonPb.Region.EU868);
  profile.setMacVersion(commonPb.MacVersion.LORAWAN_1_0_3);
  profile.setRegParamsRevision(commonPb.RegParamsRevision.RP002_1_0_3);
  profile.setAdrAlgorithmId('default');
  profile.setSupportsOtaa(true);
  profile.setFlushQueueOnActivate(true);
  profile.setUplinkInterval(withDefault(input.uplinkInterval, 3600));
  profile.setDeviceStatusReqInterval(withDefault(input.deviceStatusReqInterval, 1));
  profile.setAbpRx1Delay(0);
  profile.setAbpRx1DrOffset(0);
  profile.setAbpRx2Dr(0);
  profile.setAbpRx2Freq(0);

  if (input.autoDetectMeasurements !== undefined) {
    profile.setAutoDetectMeasurements(Boolean(input.autoDetectMeasurements));
  } else if (hasPayloadCodec) {
    profile.setAutoDetectMeasurements(true);
  }

  if (hasPayloadCodec) {
    profile.setPayloadCodecRuntime(2); // CodecRuntime.JS = 2
    profile.setPayloadCodecScript(payloadCodecScript);
  }

  return profile;
}

// --- Existing-device reconciliation helpers -------------------------------

// Normalized, comparable view of a fetched protobuf Device. IDs are
// trimmed only (ChirpStack UUID comparison is case-sensitive string
// equality); DevEUI/JoinEUI are uppercased.
function deviceSnapshot(device) {
  return {
    name: String(device.getName() || '').trim(),
    applicationId: String(device.getApplicationId() || '').trim(),
    deviceProfileId: String(device.getDeviceProfileId() || '').trim(),
    description: String(device.getDescription() || ''),
    joinEui: normalizeHexKey(device.getJoinEui ? device.getJoinEui() : ''),
    isDisabled: Boolean(device.getIsDisabled()),
  };
}

function deviceMatches(device, desired) {
  const current = deviceSnapshot(device);
  return current.name === desired.name
    && current.applicationId === desired.applicationId
    && current.deviceProfileId === desired.deviceProfileId
    && current.description === desired.description
    && current.joinEui === desired.joinEui
    && current.isDisabled === desired.isDisabled;
}

// The desired assignment always re-enables the device. An omitted
// JoinEUI in the registration input does not erase an existing value.
function buildDesiredSnapshot(input, existingDevice) {
  const suppliedJoinEui = input.joinEui !== undefined && input.joinEui !== null
    && String(input.joinEui).trim() !== '';
  const existingJoinEui = existingDevice && existingDevice.getJoinEui
    ? normalizeHexKey(existingDevice.getJoinEui())
    : '';
  return {
    name: String(input.name || input.devEui || '').trim(),
    applicationId: String(input.applicationId || '').trim(),
    deviceProfileId: String(input.deviceProfileId || '').trim(),
    description: String(input.description || ''),
    joinEui: suppliedJoinEui ? normalizeHexKey(input.joinEui) : existingJoinEui,
    isDisabled: false,
  };
}

// Forward updates (default) keep omit-preserves semantics: an empty
// snapshot JoinEUI never touches the stored value, because
// buildDesiredSnapshot already folded the existing value in. The restore
// path passes explicitJoinEui so a JoinEUI that this call's own failed
// forward write introduced is cleared back to the prior empty value.
function applySnapshotToDevice(device, snapshot, options = {}) {
  device.setName(snapshot.name);
  device.setApplicationId(snapshot.applicationId);
  device.setDeviceProfileId(snapshot.deviceProfileId);
  device.setDescription(snapshot.description);
  if (options.explicitJoinEui) {
    device.setJoinEui(snapshot.joinEui || '');
  } else if (snapshot.joinEui) {
    device.setJoinEui(snapshot.joinEui);
  }
  device.setIsDisabled(snapshot.isDisabled);
}

// Constant-time comparison so key material never leaks through a timing
// side channel. Differing lengths still perform an equivalent amount of
// work before reporting inequality.
function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

class ChirpStackClient {
  constructor(config) {
    this.apiUrl = normalizeApiUrl(config && config.apiUrl);
    this.apiKey = String(config && config.apiKey || '').trim();
    this.metadata = createMetadata(this.apiKey);
    this.credentials = createCredentials(this.apiUrl);
    this.deviceClient = new deviceGrpc.DeviceServiceClient(this.apiUrl.target, this.credentials);
    this.applicationClient = new applicationGrpc.ApplicationServiceClient(this.apiUrl.target, this.credentials);
    this.tenantClient = new tenantGrpc.TenantServiceClient(this.apiUrl.target, this.credentials);
    this.deviceProfileClient = new profileGrpc.DeviceProfileServiceClient(this.apiUrl.target, this.credentials);
    this.gatewayClient = new gatewayGrpc.GatewayServiceClient(this.apiUrl.target, this.credentials);
    this.closed = false;
    this.closeErrors = [];
  }

  async getDevice(devEui) {
    const request = new devicePb.GetDeviceRequest();
    request.setDevEui(normalizeDevEui(devEui));
    try {
      const response = await grpcInvoke(this.deviceClient, 'get', request, this.metadata, 'getDevice');
      return response.getDevice();
    } catch (error) {
      if (error.code === 'NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  async createDevice(input) {
    const device = new devicePb.Device();
    device.setDevEui(normalizeDevEui(input.devEui));
    device.setName(String(input.name || normalizeDevEui(input.devEui)));
    device.setDescription(String(input.description || ''));
    device.setApplicationId(String(input.applicationId || '').trim());
    device.setDeviceProfileId(String(input.deviceProfileId || '').trim());
    device.setIsDisabled(Boolean(input.isDisabled));
    if (input.joinEui) {
      device.setJoinEui(String(input.joinEui).trim().toUpperCase());
    }

    const request = new devicePb.CreateDeviceRequest();
    request.setDevice(device);
    return await grpcInvoke(this.deviceClient, 'create', request, this.metadata, 'createDevice');
  }

  // Mutates the fetched protobuf Device in place with only the fields
  // registration owns, keeping DevEUI unchanged, then sends a full Update.
  async updateDevice(device, desired) {
    applySnapshotToDevice(device, desired);
    const request = new devicePb.UpdateDeviceRequest();
    request.setDevice(device);
    await grpcInvoke(this.deviceClient, 'update', request, this.metadata, 'updateDevice');
  }

  // Same wire call as updateDevice, tagged with its own step so a
  // restoration failure is distinguishable from a forward-provisioning
  // update failure. Restoration always writes JoinEUI explicitly --
  // including the empty string -- so a value the failed attempt itself
  // introduced does not survive the restore.
  async restoreDevice(device, snapshot) {
    applySnapshotToDevice(device, snapshot, { explicitJoinEui: true });
    const request = new devicePb.UpdateDeviceRequest();
    request.setDevice(device);
    await grpcInvoke(this.deviceClient, 'update', request, this.metadata, 'restoreDevice');
  }

  async getKeys(devEui) {
    const request = new devicePb.GetDeviceKeysRequest();
    request.setDevEui(normalizeDevEui(devEui));
    try {
      const response = await grpcInvoke(this.deviceClient, 'getKeys', request, this.metadata, 'getKeys');
      return response.getDeviceKeys();
    } catch (error) {
      if (error.code === 'NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  async createKeys(input) {
    const keys = new devicePb.DeviceKeys();
    keys.setDevEui(normalizeDevEui(input.devEui));
    keys.setNwkKey(normalizeHexKey(input.nwkKey));
    if (input.appKey) {
      keys.setAppKey(normalizeHexKey(input.appKey));
    }
    if (input.genAppKey) {
      keys.setGenAppKey(normalizeHexKey(input.genAppKey));
    }
    const request = new devicePb.CreateDeviceKeysRequest();
    request.setDeviceKeys(keys);
    return await grpcInvoke(this.deviceClient, 'createKeys', request, this.metadata, 'createKeys');
  }

  async updateKeys(input) {
    const keys = new devicePb.DeviceKeys();
    keys.setDevEui(normalizeDevEui(input.devEui));
    keys.setNwkKey(normalizeHexKey(input.nwkKey));
    if (input.appKey) {
      keys.setAppKey(normalizeHexKey(input.appKey));
    }
    if (input.genAppKey) {
      keys.setGenAppKey(normalizeHexKey(input.genAppKey));
    }
    const request = new devicePb.UpdateDeviceKeysRequest();
    request.setDeviceKeys(keys);
    return await grpcInvoke(this.deviceClient, 'updateKeys', request, this.metadata, 'updateKeys');
  }

  async deleteKeys(devEui) {
    const request = new devicePb.DeleteDeviceKeysRequest();
    request.setDevEui(normalizeDevEui(devEui));
    try {
      await grpcInvoke(this.deviceClient, 'deleteKeys', request, this.metadata, 'deleteKeys');
      return true;
    } catch (error) {
      if (error.code === 'NOT_FOUND') {
        return false;
      }
      throw error;
    }
  }

  // Restores the complete prior key tuple (nwkKey + appKey + genAppKey)
  // via a full UpdateDeviceKeysRequest, tagged with its own step.
  async restoreKeys(devEui, snapshot) {
    const keys = new devicePb.DeviceKeys();
    keys.setDevEui(normalizeDevEui(devEui));
    keys.setNwkKey(String((snapshot && snapshot.nwkKey) || ''));
    if (snapshot && snapshot.appKey) {
      keys.setAppKey(snapshot.appKey);
    }
    if (snapshot && snapshot.genAppKey) {
      keys.setGenAppKey(snapshot.genAppKey);
    }
    const request = new devicePb.UpdateDeviceKeysRequest();
    request.setDeviceKeys(keys);
    await grpcInvoke(this.deviceClient, 'updateKeys', request, this.metadata, 'restoreKeys');
  }

  async deleteDevice(devEui) {
    const request = new devicePb.DeleteDeviceRequest();
    request.setDevEui(normalizeDevEui(devEui));
    try {
      await grpcInvoke(this.deviceClient, 'delete', request, this.metadata, 'deleteDevice');
      return true;
    } catch (error) {
      if (error.code === 'NOT_FOUND') {
        return false;
      }
      throw error;
    }
  }

  // Ownership-fence compensation. Decides, from what this call itself did
  // and where it failed, whether to (a) treat the failure as a plain
  // operational error and attempt to roll back only what this call wrote,
  // or (b) treat it as proof of a concurrent actor and perform zero
  // compensating mutations, surfacing bounded RECONCILIATION_REQUIRED
  // instead. A verifyKeys mismatch on a pre-existing device is case (b):
  // registration is the sole owner of key material, so drift there is
  // external. A verifyKeys mismatch on a device this call CREATED still
  // owes create-rollback -- but only while the aggregate ownership fence
  // holds: the device is re-fetched, and only if it still equals the
  // desired snapshot this call already verified is the new device deleted;
  // any drift means a foreign writer owns it now, so zero compensating
  // mutations happen and RECONCILIATION_REQUIRED is returned. A
  // verifyDevice mismatch is case (b) only once this call has already
  // recorded one successful verified read for the device in this same
  // invocation (ctx.deviceVerified) -- i.e. a second, later disagreement
  // proves someone else changed it after our own write was confirmed.
  async _compensateProvisioning(ctx, error) {
    if (error.step === 'verifyKeys') {
      if (!ctx.deviceCreated) {
        return reconciliationRequiredError('verifyKeys', 'keys');
      }
      const rollbackErrors = [];
      let fenceHolds = false;
      try {
        const fenceDevice = await this.getDevice(ctx.devEui);
        fenceHolds = Boolean(
          fenceDevice
          && ctx.desiredSnapshot
          && deviceMatches(fenceDevice, ctx.desiredSnapshot)
        );
      } catch (fenceError) {
        rollbackErrors.push(fenceError);
      }
      if (!rollbackErrors.length && !fenceHolds) {
        return reconciliationRequiredError('verifyKeys', 'keys');
      }
      if (fenceHolds) {
        try {
          await this.deleteDevice(ctx.devEui);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) {
        const combined = boundedError(error.step, error.code);
        combined.rollback = rollbackErrors.map((entry) => ({
          step: normalizeStep(entry && entry.step),
          code: normalizeResultCode(entry && entry.code),
        }));
        return combined;
      }
      return error;
    }
    if (error.step === 'verifyDevice' && ctx.deviceVerified) {
      return reconciliationRequiredError('verifyDevice', 'device');
    }

    const rollbackErrors = [];

    // A successful forward write is only ours to undo while the whole
    // aggregate still has the exact device and key snapshots that this
    // invocation verified. Check every fence before making any compensating
    // mutation so a concurrent registrar cannot have one half overwritten.
    if (ctx.deviceCreated || ctx.deviceMutated || ctx.keysCreatedNew || ctx.keysMutated) {
      // Fetch only the components this invocation actually mutated. A
      // device-only repair makes no key RPC here, and a key-only repair
      // makes no device RPC -- an unscoped fetch of the untouched half
      // would either throw needlessly or fence against state this call
      // never wrote to.
      const needsDeviceFence = ctx.deviceCreated || ctx.deviceMutated;
      const needsKeysFence = ctx.keysCreatedNew || ctx.keysMutated;
      try {
        const [fenceDevice, fenceKeys] = await Promise.all([
          needsDeviceFence ? this.getDevice(ctx.devEui) : Promise.resolve(null),
          needsKeysFence ? this.getKeys(ctx.devEui) : Promise.resolve(null),
        ]);
        const deviceFenceHolds = !needsDeviceFence || Boolean(
          fenceDevice && ctx.desiredSnapshot && deviceMatches(fenceDevice, ctx.desiredSnapshot)
        );
        const keysFenceHolds = !needsKeysFence || Boolean(
          fenceKeys
          && ctx.desiredKeysSnapshot
          && constantTimeEqual(normalizeHexKey(fenceKeys.getNwkKey()), ctx.desiredKeysSnapshot.nwkKey)
          && constantTimeEqual(normalizeHexKey(fenceKeys.getAppKey()), ctx.desiredKeysSnapshot.appKey)
          && constantTimeEqual(normalizeHexKey(fenceKeys.getGenAppKey()), ctx.desiredKeysSnapshot.genAppKey)
        );
        if (!deviceFenceHolds || !keysFenceHolds) {
          return reconciliationRequiredError(error.step, !deviceFenceHolds ? 'device' : 'keys');
        }
        ctx.compensationFenceDevice = fenceDevice;
      } catch (fenceError) {
        rollbackErrors.push(fenceError);
      }
      if (rollbackErrors.length) {
        const combined = boundedError(error.step, error.code);
        combined.rollback = rollbackErrors.map((entry) => ({
          step: normalizeStep(entry && entry.step),
          code: normalizeResultCode(entry && entry.code),
        }));
        return combined;
      }
    }

    if (ctx.deviceCreated) {
      try {
        await this.deleteDevice(ctx.devEui);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    } else if (ctx.deviceMutated && ctx.originalDeviceSnapshot) {
      try {
        const device = ctx.compensationFenceDevice;
        if (device) {
          await this.restoreDevice(device, ctx.originalDeviceSnapshot);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (ctx.keysCreatedNew) {
      try {
        await this.deleteKeys(ctx.devEui);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    } else if (ctx.keysMutated && ctx.originalKeysSnapshot) {
      try {
        await this.restoreKeys(ctx.devEui, ctx.originalKeysSnapshot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length) {
      const combined = boundedError(error.step, error.code);
      combined.rollback = rollbackErrors.map((entry) => ({
        step: normalizeStep(entry && entry.step),
        code: normalizeResultCode(entry && entry.code),
      }));
      return combined;
    }

    return error;
  }

  async ensureDeviceProvisioned(input) {
    const devEui = normalizeDevEui(input.devEui);
    const nwkKey = normalizeHexKey(input.appKey);
    const applicationId = String(input.applicationId || '').trim();
    const deviceProfileId = String(input.deviceProfileId || '').trim();

    if (!devEui) {
      throw boundedError('validate', 'INVALID_ARGUMENT');
    }
    if (!applicationId || !deviceProfileId) {
      throw boundedError('validate', 'INVALID_ARGUMENT');
    }
    if (!/^[0-9A-F]{32}$/.test(nwkKey)) {
      throw boundedError('validate', 'INVALID_ARGUMENT');
    }

    const ctx = {
      devEui,
      deviceCreated: false,
      deviceMutated: false,
      deviceVerified: false,
      originalDeviceSnapshot: null,
      desiredSnapshot: null,
      keysCreatedNew: false,
      keysMutated: false,
      originalKeysSnapshot: null,
      desiredKeysSnapshot: null,
    };

    try {
      let device = await this.getDevice(devEui);
      if (!device) {
        try {
          await this.createDevice({
            devEui,
            name: String(input.name || devEui).trim(),
            applicationId,
            deviceProfileId,
            isDisabled: false,
            joinEui: input.joinEui || undefined,
            description: input.description || ''
          });
          ctx.deviceCreated = true;
        } catch (error) {
          if (error.code !== 'ALREADY_EXISTS') {
            throw error;
          }
        }
      }

      // Reread after create (or after an ALREADY_EXISTS race) so every
      // path below observes the real stored assignment.
      device = await this.getDevice(devEui);
      if (!device) {
        throw boundedError('verifyDevice', 'NOT_FOUND');
      }
      if (!ctx.deviceCreated) {
        ctx.originalDeviceSnapshot = deviceSnapshot(device);
      }

      const desired = buildDesiredSnapshot(input, device);
      ctx.desiredSnapshot = desired;

      let deviceAction;
      if (ctx.deviceCreated) {
        deviceAction = 'created';
      } else if (deviceMatches(device, desired)) {
        deviceAction = 'unchanged';
      } else {
        await this.updateDevice(device, desired);
        ctx.deviceMutated = true;
        deviceAction = 'updated';
      }

      const verifiedDevice = await this.getDevice(devEui);
      if (!verifiedDevice || !deviceMatches(verifiedDevice, desired)) {
        throw boundedError('verifyDevice', 'FAILED_PRECONDITION');
      }
      ctx.deviceVerified = true;

      let keysAction = 'unchanged';
      let expectedAppKey = '';
      let expectedGenAppKey = '';
      const existingKeys = await this.getKeys(devEui);
      if (!existingKeys) {
        // Record the expected post-write key tuple BEFORE the mutating
        // RPC below. If the device reread that follows fails, compensation
        // still has a key snapshot to fence against -- without this, a
        // failed reread would leave ctx.desiredKeysSnapshot null and the
        // aggregate fence would treat a successful key write as unfenced.
        ctx.desiredKeysSnapshot = { nwkKey, appKey: expectedAppKey, genAppKey: expectedGenAppKey };
        await this.createKeys({ devEui, nwkKey });
        ctx.keysCreatedNew = true;
        keysAction = 'created';
      } else {
        const originalKeys = {
          nwkKey: normalizeHexKey(existingKeys.getNwkKey()),
          appKey: normalizeHexKey(existingKeys.getAppKey()),
          genAppKey: normalizeHexKey(existingKeys.getGenAppKey()),
        };
        ctx.originalKeysSnapshot = originalKeys;
        expectedAppKey = originalKeys.appKey;
        expectedGenAppKey = originalKeys.genAppKey;
        // Same before-the-RPC ordering guarantee as the create branch above.
        ctx.desiredKeysSnapshot = { nwkKey, appKey: expectedAppKey, genAppKey: expectedGenAppKey };
        if (!constantTimeEqual(originalKeys.nwkKey, nwkKey)) {
          await this.updateKeys({
            devEui,
            nwkKey,
            appKey: originalKeys.appKey || undefined,
            genAppKey: originalKeys.genAppKey || undefined,
          });
          ctx.keysMutated = true;
          keysAction = 'updated';
        }
      }

      // Reread the device again after the key mutation window. Any
      // disagreement here -- given the first reread above already
      // confirmed a match -- is proof of a concurrent reassignment.
      const finalDevice = await this.getDevice(devEui);
      if (!finalDevice || !deviceMatches(finalDevice, desired)) {
        throw boundedError('verifyDevice', 'FAILED_PRECONDITION');
      }

      const finalKeys = await this.getKeys(devEui);
      const keysOk = Boolean(finalKeys)
        && constantTimeEqual(normalizeHexKey(finalKeys.getNwkKey()), nwkKey)
        && constantTimeEqual(normalizeHexKey(finalKeys.getAppKey()), expectedAppKey)
        && constantTimeEqual(normalizeHexKey(finalKeys.getGenAppKey()), expectedGenAppKey);
      if (!keysOk) {
        throw boundedError('verifyKeys', 'FAILED_PRECONDITION');
      }

      const result = {
        devEui,
        deviceAction,
        keysAction,
        keysVerified: true,
        verifiedApplicationId: desired.applicationId,
        verifiedDeviceProfileId: desired.deviceProfileId,
      };
      Object.defineProperty(result, 'compensate', {
        enumerable: false,
        value: async () => {
          const dbError = boundedError('db', 'UNKNOWN');
          const compensation = await this._compensateProvisioning(ctx, dbError);
          if (compensation !== dbError) throw compensation;
        },
      });
      return result;
    } catch (error) {
      throw await this._compensateProvisioning(ctx, error);
    }
  }

  async listTenants() {
    return await paginate(
      (limit, offset) => {
        const request = new tenantPb.ListTenantsRequest();
        request.setLimit(limit);
        request.setOffset(offset);
        return request;
      },
      (request) => grpcInvoke(this.tenantClient, 'list', request, this.metadata, 'listTenants'),
      'getResultList'
    );
  }

  async createTenant(input) {
    const tenant = new tenantPb.Tenant();
    tenant.setName(String(input.name || 'Open Smart Irrigation').trim());
    tenant.setDescription(String(withDefault(input.description, 'OSI bootstrap tenant')));
    tenant.setCanHaveGateways(withDefault(input.canHaveGateways, true));
    tenant.setMaxGatewayCount(withDefault(input.maxGatewayCount, 0));
    tenant.setMaxDeviceCount(withDefault(input.maxDeviceCount, 0));
    tenant.setPrivateGatewaysUp(withDefault(input.privateGatewaysUp, false));
    tenant.setPrivateGatewaysDown(withDefault(input.privateGatewaysDown, false));

    const request = new tenantPb.CreateTenantRequest();
    request.setTenant(tenant);
    return await grpcInvoke(this.tenantClient, 'create', request, this.metadata, 'createTenant');
  }

  async listApplications(tenantId) {
    return await paginate(
      (limit, offset) => {
        const request = new applicationPb.ListApplicationsRequest();
        request.setTenantId(String(tenantId || '').trim());
        request.setLimit(limit);
        request.setOffset(offset);
        return request;
      },
      (request) => grpcInvoke(this.applicationClient, 'list', request, this.metadata, 'listApplications'),
      'getResultList'
    );
  }

  async createApplication(input) {
    const application = new applicationPb.Application();
    application.setTenantId(String(input.tenantId || '').trim());
    application.setName(String(input.name || '').trim());
    application.setDescription(String(withDefault(input.description, '')));

    const request = new applicationPb.CreateApplicationRequest();
    request.setApplication(application);
    return await grpcInvoke(this.applicationClient, 'create', request, this.metadata, 'createApplication');
  }

  async listDeviceProfiles(tenantId) {
    return await paginate(
      (limit, offset) => {
        const request = new profilePb.ListDeviceProfilesRequest();
        request.setTenantId(String(tenantId || '').trim());
        request.setLimit(limit);
        request.setOffset(offset);
        return request;
      },
      (request) => grpcInvoke(this.deviceProfileClient, 'list', request, this.metadata, 'listDeviceProfiles'),
      'getResultList'
    );
  }

  async getDeviceProfile(id) {
    const request = new profilePb.GetDeviceProfileRequest();
    request.setId(String(id || '').trim());
    try {
      const response = await grpcInvoke(this.deviceProfileClient, 'get', request, this.metadata, 'getDeviceProfile');
      return response.getDeviceProfile();
    } catch (error) {
      if (error.code === 'NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  async createDeviceProfile(input) {
    const profile = buildDeviceProfileMessage(input);
    const request = new profilePb.CreateDeviceProfileRequest();
    request.setDeviceProfile(profile);
    return await grpcInvoke(this.deviceProfileClient, 'create', request, this.metadata, 'createDeviceProfile');
  }

  async updateDeviceProfile(input) {
    const profile = buildDeviceProfileMessage(input);
    const request = new profilePb.UpdateDeviceProfileRequest();
    request.setDeviceProfile(profile);
    return await grpcInvoke(this.deviceProfileClient, 'update', request, this.metadata, 'updateDeviceProfile');
  }

  async getGateway(gatewayId) {
    const request = new gatewayPb.GetGatewayRequest();
    request.setGatewayId(normalizeDevEui(gatewayId));
    try {
      const response = await grpcInvoke(this.gatewayClient, 'get', request, this.metadata, 'getGateway');
      return response.getGateway();
    } catch (error) {
      if (error.code === 'NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  async updateGatewayLocation(gatewayId, input) {
    const gateway = await this.getGateway(gatewayId);
    if (!gateway) {
      throw boundedError('updateGatewayLocation', 'NOT_FOUND');
    }

    const location = new commonPb.Location();
    location.setLatitude(Number(input.latitude));
    location.setLongitude(Number(input.longitude));
    if (input.altitude !== undefined && input.altitude !== null && Number.isFinite(Number(input.altitude))) {
      location.setAltitude(Number(input.altitude));
    }
    gateway.setLocation(location);

    const request = new gatewayPb.UpdateGatewayRequest();
    request.setGateway(gateway);
    return await grpcInvoke(this.gatewayClient, 'update', request, this.metadata, 'updateGatewayLocation');
  }

  async flushDeviceQueue(devEui) {
    const normalizedDevEui = normalizeDevEui(devEui);
    if (!normalizedDevEui) {
      throw boundedError('flushDeviceQueue', 'INVALID_ARGUMENT');
    }
    const request = new devicePb.FlushDeviceQueueRequest();
    request.setDevEui(normalizedDevEui);
    await grpcInvoke(this.deviceClient, 'flushQueue', request, this.metadata, 'flushDeviceQueue');
    return {
      devEui: normalizedDevEui,
      method: 'DeviceService.FlushQueue'
    };
  }

  // Idempotent, close-all, data-free. Every distinct underlying service
  // client receives exactly one close call across the lifetime of this
  // instance; a throwing client never prevents any other client from
  // closing, and only the allowlisted service role + fixed CLOSE_FAILED
  // code is ever retained -- never the thrown exception's text.
  close() {
    if (this.closed) {
      return this.closeErrors || [];
    }
    const closeErrors = [];
    for (const [service, client] of distinctNamedClients(this)) {
      try {
        if (client && typeof client.close === 'function') {
          client.close();
        }
      } catch (_error) {
        closeErrors.push({ service, code: 'CLOSE_FAILED' });
      }
    }
    this.closeErrors = closeErrors;
    this.closed = true;
    return closeErrors;
  }
}

function createClient(config) {
  return new ChirpStackClient(config || {});
}

function createProvisioningClientFromEnv(env) {
  const lookup = env && typeof env.get === 'function'
    ? (key) => env.get(key)
    : (key) => process.env[key];
  return createClient({
    apiUrl: lookup('CHIRPSTACK_API_URL'),
    apiKey: lookup('CHIRPSTACK_API_KEY')
  });
}

module.exports = {
  createClient,
  createProvisioningClientFromEnv,
  ChirpStackClient,
  grpcInvoke,
  DEFAULT_RPC_TIMEOUT_MS,
  deviceSnapshot,
  deviceMatches,
  normalizeApiUrl,
  normalizeDevEui,
  normalizeHexKey,
  listItemToObject,
  enums: {
    Region: commonPb.Region,
    MacVersion: commonPb.MacVersion,
    RegParamsRevision: commonPb.RegParamsRevision
  }
};
