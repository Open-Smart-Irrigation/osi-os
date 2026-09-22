'use strict';

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

function withDefault(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : value;
}

function normalizeDevEui(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeHexKey(value) {
  return String(value || '').trim().toUpperCase();
}

// ChirpStack 4.12 reads an unset appKey/genAppKey as 32 zero hex chars;
// older versions returned an empty string. Treat both as the same stored key.
const UNSET_KEY_ZEROS = '0'.repeat(32);

function canonicalStoredKey(value) {
  const normalized = normalizeHexKey(value);
  return normalized === '' ? UNSET_KEY_ZEROS : normalized;
}

function storedKeyEqual(a, b) {
  return canonicalStoredKey(a) === canonicalStoredKey(b);
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
    if (value === code) return name;
  }
  return `CODE_${code}`;
}

function toGrpcError(error, step) {
  if (!error) {
    const fallback = new Error('Unknown ChirpStack gRPC error');
    fallback.step = step;
    fallback.code = null;
    fallback.grpcStatus = 'UNKNOWN';
    return fallback;
  }
  const wrapped = new Error(String(error.details || error.message || error));
  wrapped.step = step;
  wrapped.code = Number.isFinite(error.code) ? error.code : null;
  wrapped.grpcStatus = grpcStatusName(wrapped.code);
  wrapped.details = String(error.details || error.message || error);
  wrapped.raw = error;
  return wrapped;
}

function annotateError(error, step) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.step = wrapped.step || step;
  return wrapped;
}

// A ChirpStack that accepts the connection and never answers (it does that while it
// restarts) left these promises pending for ever, and with them every HTTP route that
// awaits one: the valve cancel, the valve API router, the device delete clean-up. With a
// deadline grpc-js ends the call itself and the caller gets DEADLINE_EXCEEDED.
const DEFAULT_GRPC_DEADLINE_MS = 20000;
// Upper bound for the setting. grpc-js reads a deadline more than 2^31-1 ms away as "none"
// and arms no timer, so an oversized value would switch the deadline off again.
const MAX_GRPC_DEADLINE_MS = 120000;

// A rename waits behind this call: the REST handler answers only once it settles,
// and the command applier holds its database handle open across it. Twenty seconds
// of a restarting ChirpStack is too long for a label change, so the name update
// carries its own budget. It never exceeds the general setting, so lowering
// OSI_CHIRPSTACK_GRPC_DEADLINE_MS lowers this one too.
const NAME_UPDATE_DEADLINE_MS = 5000;

function grpcDeadlineMs() {
  const configured = Number(process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_GRPC_DEADLINE_MS;
  return Math.min(configured, MAX_GRPC_DEADLINE_MS);
}

function nameUpdateDeadlineMs() {
  return Math.min(NAME_UPDATE_DEADLINE_MS, grpcDeadlineMs());
}

// deadlineMs is optional: a caller that needs a shorter budget than the general
// setting passes one, and every existing call site keeps grpcDeadlineMs().
// It may also be a FUNCTION returning the milliseconds still left of a budget
// that covers several RPCs. The getter is called here, at the moment the call
// is actually issued, so the second RPC of an operation gets what the first
// one left rather than a fresh full budget.
function grpcInvoke(client, methodName, request, metadata, step, deadlineMs) {
  return new Promise((resolve, reject) => {
    const isGetter = typeof deadlineMs === 'function';
    const requested = Number(isGetter ? deadlineMs() : deadlineMs);
    const generalMs = grpcDeadlineMs();
    let budgetMs;
    if (!Number.isFinite(requested)) {
      budgetMs = generalMs;
    } else if (requested > 0) {
      budgetMs = Math.min(requested, generalMs);
    } else if (isGetter) {
      // The shared budget is already spent. That is an expired deadline, not
      // "no deadline": falling back to the general setting here would hand
      // this call the very twenty seconds the shared budget exists to avoid.
      budgetMs = 0;
    } else {
      budgetMs = generalMs;
    }
    const options = { deadline: new Date(Date.now() + budgetMs) };
    client[methodName](request, metadata, options, (error, response) => {
      if (error) {
        reject(toGrpcError(error, step || methodName));
        return;
      }
      resolve(response);
    });
  });
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
  }

  async getDevice(devEui, options) {
    const request = new devicePb.GetDeviceRequest();
    request.setDevEui(normalizeDevEui(devEui));
    try {
      const response = await grpcInvoke(
        this.deviceClient, 'get', request, this.metadata, 'getDevice',
        options && options.deadlineMs
      );
      return response.getDevice();
    } catch (error) {
      if (error.code === grpc.status.NOT_FOUND) {
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

  async getKeys(devEui) {
    const request = new devicePb.GetDeviceKeysRequest();
    request.setDevEui(normalizeDevEui(devEui));
    try {
      const response = await grpcInvoke(this.deviceClient, 'getKeys', request, this.metadata, 'getKeys');
      return response.getDeviceKeys();
    } catch (error) {
      if (error.code === grpc.status.NOT_FOUND) {
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

  async deleteDevice(devEui) {
    const request = new devicePb.DeleteDeviceRequest();
    request.setDevEui(normalizeDevEui(devEui));
    try {
      await grpcInvoke(this.deviceClient, 'delete', request, this.metadata, 'deleteDevice');
      return true;
    } catch (error) {
      if (error.code === grpc.status.NOT_FOUND) {
        return false;
      }
      throw error;
    }
  }

  async setDeviceProfile(devEui, deviceProfileId) {
    const targetId = String(deviceProfileId || '').trim();
    if (!targetId) throw annotateError(new Error('setDeviceProfile: deviceProfileId is required'), 'validate');
    const existing = await this.getDevice(devEui);
    if (!existing) return false;
    if (String(existing.getDeviceProfileId() || '') === targetId) return false;
    existing.setDeviceProfileId(targetId);
    const request = new devicePb.UpdateDeviceRequest();
    request.setDevice(existing);
    await grpcInvoke(this.deviceClient, 'update', request, this.metadata, 'setDeviceProfile');
    return true;
  }

  // The one place that reads, compares and writes a ChirpStack device name.
  // Re-reads the device rather than taking a caller's copy: a profile
  // repoint (or another rename) may have just written to it, and an
  // UpdateDeviceRequest replaces the whole message. Shared by
  // ensureDeviceProvisioned (general deadline, no options) and the module-level
  // updateDeviceName (bounded deadline via options.deadlineMs, its own step
  // name via options.step). options.deadlineMs may be a fixed number of
  // milliseconds or a getter returning what is left of a budget that covers
  // both RPCs below; it is passed straight through to each one, which resolves
  // it when it issues its call. A blank name -- after trimming -- and a device
  // ChirpStack does not have both resolve 'skipped' with no update RPC; a
  // blank name is 'skipped' before any gRPC read at all.
  async setDeviceName(devEui, name, options) {
    const opts = options || {};
    const step = opts.step || 'setDeviceName';
    const wanted = String(name === null || name === undefined ? '' : name).trim();
    if (!wanted) return 'skipped';
    const existing = await this.getDevice(devEui, { deadlineMs: opts.deadlineMs });
    if (!existing) return 'skipped';
    if (String(existing.getName() || '') === wanted) return 'unchanged';
    existing.setName(wanted);
    const request = new devicePb.UpdateDeviceRequest();
    request.setDevice(existing);
    await grpcInvoke(this.deviceClient, 'update', request, this.metadata, step, opts.deadlineMs);
    return 'updated';
  }

  async ensureDeviceProvisioned(input) {
    const devEui = normalizeDevEui(input.devEui);
    const appKey = normalizeHexKey(input.appKey);
    const applicationId = String(input.applicationId || '').trim();
    const deviceProfileId = String(input.deviceProfileId || '').trim();
    // createDevice needs a name for a brand-new device, so it falls back to the
    // DevEUI. Reconciling an EXISTING device must never invent that fallback --
    // an omitted or blank `name` on a rename-less call must leave ChirpStack's
    // label alone, so reconciliation below reads providedName, not name.
    const name = String(input.name || devEui).trim();
    const providedName = String(input.name || '').trim();

    if (!devEui) {
      throw annotateError(new Error('DevEUI is required'), 'validate');
    }
    if (!applicationId || !deviceProfileId) {
      throw annotateError(new Error('ChirpStack application/profile mapping is incomplete'), 'validate');
    }
    if (!/^[0-9A-F]{32}$/.test(appKey)) {
      throw annotateError(new Error('AppKey must be exactly 32 uppercase hex characters'), 'validate');
    }
    if (appKey === UNSET_KEY_ZEROS) {
      // An all-zero requested key is indistinguishable from an unset key on
      // read-back, so it would compare as "unchanged" against a device that has
      // no key at all. Refuse it here; the comparator needs the canonical form.
      throw annotateError(new Error('AppKey must not be all zeros'), 'validate');
    }

    const keySpec = { devEui, nwkKey: appKey };
    let deviceCreated = false;
    let keysAction = 'unchanged';
    let profileAction = 'unchanged';
    let nameAction = 'unchanged';

    try {
      const existingDevice = await this.getDevice(devEui);
      if (!existingDevice) {
        try {
          await this.createDevice({
            devEui,
            name,
            applicationId,
            deviceProfileId,
            isDisabled: false,
            joinEui: input.joinEui || undefined,
            description: input.description || ''
          });
          deviceCreated = true;
        } catch (error) {
          if (error.code !== grpc.status.ALREADY_EXISTS) {
            throw error;
          }
        }
      } else {
        if (String(existingDevice.getDeviceProfileId() || '') !== deviceProfileId) {
          // setDeviceProfile re-fetches the device itself (the price of routing every
          // profile assignment through the single seam); its boolean return is the
          // truth about whether an update RPC was actually issued -- do not assume
          // 'repointed' just because the two getDevice reads disagreed once.
          profileAction = (await this.setDeviceProfile(devEui, deviceProfileId)) ? 'repointed' : 'unchanged';
        }
        // The OSI database owns the label, and only when the caller actually
        // supplied one: an omitted/blank providedName leaves ChirpStack alone,
        // exactly like leaving keysAction/profileAction at 'unchanged' above.
        // A rename that could not reach ChirpStack (an outage, a restart) heals
        // at the next provisioning. createDevice above already set the name on
        // a brand-new device, so this runs only for one that was already there.
        //
        // The name comparison uses existingDevice, already read above, to cost
        // no extra round trip when it already matches (the profile repoint
        // just above, if it ran, only ever touches deviceProfileId, so
        // existingDevice's name is still current). Only a genuine difference
        // pays for setDeviceName's own fresh read -- required for correctness,
        // since a repoint may have just replaced the whole device message and
        // existingDevice's copy of it would be stale to send back.
        if (providedName) {
          nameAction = String(existingDevice.getName() || '') === providedName
            ? 'unchanged'
            : await this.setDeviceName(devEui, providedName, { step: 'ensureDeviceProvisioned' });
        }
      }

      const existingKeys = await this.getKeys(devEui);
      if (!existingKeys) {
        await this.createKeys(keySpec);
        keysAction = 'created';
      } else if (
        !storedKeyEqual(existingKeys.getNwkKey(), keySpec.nwkKey) ||
        !storedKeyEqual(existingKeys.getAppKey(), '')
      ) {
        await this.updateKeys(keySpec);
        keysAction = 'updated';
      }

      return {
        devEui,
        deviceCreated,
        deviceExisted: !deviceCreated,
        keysAction,
        profileAction,
        nameAction
      };
    } catch (error) {
      if (deviceCreated) {
        try {
          await this.deleteDevice(devEui);
        } catch (_) {}
      }
      throw annotateError(error, error.step || 'ensureDeviceProvisioned');
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
      if (error.code === grpc.status.NOT_FOUND) {
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
      if (error.code === grpc.status.NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  async updateGatewayLocation(gatewayId, input) {
    const gateway = await this.getGateway(gatewayId);
    if (!gateway) {
      throw annotateError(new Error(`Gateway ${normalizeDevEui(gatewayId)} not found in ChirpStack`), 'updateGatewayLocation');
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
      throw annotateError(new Error('DevEUI is required'), 'flushDeviceQueue');
    }
    const request = new devicePb.FlushDeviceQueueRequest();
    request.setDevEui(normalizedDevEui);
    await grpcInvoke(this.deviceClient, 'flushQueue', request, this.metadata, 'flushDeviceQueue');
    return {
      devEui: normalizedDevEui,
      method: 'DeviceService.FlushQueue'
    };
  }
}

// One promise chain per DevEUI. Two renames of one device in quick succession
// must end with ChirpStack on the newer name whichever gRPC call is slower, so
// the second call's readCurrentName and its update RPC both wait for the first
// to settle. The chain is dropped once it drains, so the map cannot grow with
// the fleet.
const deviceNameQueues = new Map();

function serializeByDevEui(devEui, task) {
  const previous = deviceNameQueues.get(devEui) || Promise.resolve();
  const scheduled = previous.then(task, task);
  const settled = scheduled.then(() => undefined, () => undefined);
  deviceNameQueues.set(devEui, settled);
  settled.then(() => {
    if (deviceNameQueues.get(devEui) === settled) deviceNameQueues.delete(devEui);
  });
  return scheduled;
}

// readCurrentName reads devices.name from SQLite at the moment this call
// actually runs, never before it is queued: the value that reaches ChirpStack
// is the one the database holds after every earlier rename has committed.
// Delegates to ChirpStackClient.setDeviceName for the actual read-compare-update
// (the one place that trims and refuses a blank name). nameUpdateDeadlineMs()
// is ONE budget for the whole update, armed when this task starts rather than
// when it was queued, and each RPC gets what is left of it. Giving both RPCs
// the full budget instead cost a caller up to ten seconds against a ChirpStack
// that accepts the connection and never answers -- past the dashboard's
// ten-second HTTP timeout, so the operator saw a save failure after a rename
// that had already committed.
async function updateDeviceName(client, devEui, readCurrentName) {
  const normalized = normalizeDevEui(devEui);
  if (!/^[0-9A-F]{16}$/.test(normalized)) {
    throw annotateError(new Error('DevEUI is required'), 'updateDeviceName');
  }
  if (typeof readCurrentName !== 'function') {
    throw annotateError(new Error('updateDeviceName requires a readCurrentName function'), 'updateDeviceName');
  }
  return serializeByDevEui(normalized, async () => {
    const expiresAt = Date.now() + nameUpdateDeadlineMs();
    const stored = await readCurrentName();
    if (stored === null || stored === undefined) return 'skipped';
    return client.setDeviceName(normalized, stored, {
      deadlineMs: () => expiresAt - Date.now(),
      step: 'updateDeviceName'
    });
  });
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
  updateDeviceName,
  NAME_UPDATE_DEADLINE_MS,
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
