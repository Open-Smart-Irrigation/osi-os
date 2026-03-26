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

function grpcInvoke(client, methodName, request, metadata, step) {
  return new Promise((resolve, reject) => {
    client[methodName](request, metadata, (error, response) => {
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

class ChirpStackClient {
  constructor(config) {
    this.apiUrl = normalizeApiUrl(config && config.apiUrl);
    this.metadata = createMetadata(config && config.apiKey);
    this.credentials = createCredentials(this.apiUrl);
    this.deviceClient = new deviceGrpc.DeviceServiceClient(this.apiUrl.target, this.credentials);
    this.applicationClient = new applicationGrpc.ApplicationServiceClient(this.apiUrl.target, this.credentials);
    this.tenantClient = new tenantGrpc.TenantServiceClient(this.apiUrl.target, this.credentials);
    this.deviceProfileClient = new profileGrpc.DeviceProfileServiceClient(this.apiUrl.target, this.credentials);
  }

  async getDevice(devEui) {
    const request = new devicePb.GetDeviceRequest();
    request.setDevEui(normalizeDevEui(devEui));
    try {
      const response = await grpcInvoke(this.deviceClient, 'get', request, this.metadata, 'getDevice');
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

  async ensureDeviceProvisioned(input) {
    const devEui = normalizeDevEui(input.devEui);
    const appKey = normalizeHexKey(input.appKey);
    const applicationId = String(input.applicationId || '').trim();
    const deviceProfileId = String(input.deviceProfileId || '').trim();
    const name = String(input.name || devEui).trim();

    if (!devEui) {
      throw annotateError(new Error('DevEUI is required'), 'validate');
    }
    if (!applicationId || !deviceProfileId) {
      throw annotateError(new Error('ChirpStack application/profile mapping is incomplete'), 'validate');
    }
    if (!/^[0-9A-F]{32}$/.test(appKey)) {
      throw annotateError(new Error('AppKey must be exactly 32 uppercase hex characters'), 'validate');
    }

    const keySpec = { devEui, nwkKey: appKey };
    let deviceCreated = false;
    let keysAction = 'unchanged';

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
      }

      const existingKeys = await this.getKeys(devEui);
      if (!existingKeys) {
        await this.createKeys(keySpec);
        keysAction = 'created';
      } else if (
        normalizeHexKey(existingKeys.getNwkKey()) !== keySpec.nwkKey ||
        normalizeHexKey(existingKeys.getAppKey()) !== ''
      ) {
        await this.updateKeys(keySpec);
        keysAction = 'updated';
      }

      return {
        devEui,
        deviceCreated,
        deviceExisted: !deviceCreated,
        keysAction
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

  async createDeviceProfile(input) {
    const regionName = String(input.region || 'EU868').trim().toUpperCase();
    const profile = new profilePb.DeviceProfile();
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

    const request = new profilePb.CreateDeviceProfileRequest();
    request.setDeviceProfile(profile);
    return await grpcInvoke(this.deviceProfileClient, 'create', request, this.metadata, 'createDeviceProfile');
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
