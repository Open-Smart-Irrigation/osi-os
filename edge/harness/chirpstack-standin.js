'use strict';
// A fuller ChirpStack gRPC stand-in than scripts/fixtures/release-smoke/radio.js
// (which stays untouched): the DeviceService queue quartet behaves byte-exactly
// like radio.js, and the device/profile/application/tenant/gateway RPCs the
// claim and rename paths call (osi-chirpstack-helper) are implemented against
// in-memory state seeded with synthetic ids, so POST /api/devices and
// PUT /api/devices/:deveui/name can be recorded on their success paths.
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TENANT_ID = 'synthetic-tenant';
const GATEWAY_ID = '0016C001F1000001';

// Synthetic profile ids, one per device type. Fixed (not random) so both the
// oracle and the fakes seed the same values the CHIRPSTACK_PROFILE_* env
// points at. Env map exported for oracle-node-red.js and lib/backend.js.
const PROFILE_IDS = {
  KIWI_SENSOR: '11111111-1111-4111-8111-111111111111',
  STREGA_VALVE: '11111111-1111-4111-8111-111111111112',
  DRAGINO_LSN50: '11111111-1111-4111-8111-111111111113',
  TEKTELIC_CLOVER: '11111111-1111-4111-8111-111111111114',
  SENSECAP_S2120: '11111111-1111-4111-8111-111111111115',
  AQUASCOPE_LORAIN: '11111111-1111-4111-8111-111111111116',
  MILESIGHT_UC512: '11111111-1111-4111-8111-111111111117',
  DRAGINO_SDI12: '11111111-1111-4111-8111-111111111118',
  RAK10701_FIELD_TESTER: '11111111-1111-4111-8111-111111111119',
  STREGA_VALVE_GEN2: '11111111-1111-4111-8111-11111111111A',
};
const ENV = {
  CHIRPSTACK_PROFILE_KIWI: PROFILE_IDS.KIWI_SENSOR,
  CHIRPSTACK_PROFILE_STREGA: PROFILE_IDS.STREGA_VALVE,
  CHIRPSTACK_PROFILE_STREGA_GEN2: PROFILE_IDS.STREGA_VALVE_GEN2,
  CHIRPSTACK_PROFILE_LSN50: PROFILE_IDS.DRAGINO_LSN50,
  CHIRPSTACK_PROFILE_CLOVER: PROFILE_IDS.TEKTELIC_CLOVER,
  CHIRPSTACK_PROFILE_S2120: PROFILE_IDS.SENSECAP_S2120,
  CHIRPSTACK_PROFILE_LORAIN: PROFILE_IDS.AQUASCOPE_LORAIN,
  CHIRPSTACK_PROFILE_UC512: PROFILE_IDS.MILESIGHT_UC512,
  CHIRPSTACK_PROFILE_SDI12: PROFILE_IDS.DRAGINO_SDI12,
  CHIRPSTACK_PROFILE_RAK10701: PROFILE_IDS.RAK10701_FIELD_TESTER,
};

// App ids match the values the release-smoke runtime and SHARED_ENV already
// put in CHIRPSTACK_APP_SENSORS / CHIRPSTACK_APP_ACTUATORS.
const APP_IDS = {
  sensors: 'synthetic-sensors-app',
  actuators: 'synthetic-actuators-app',
  fieldTester: 'synthetic-field-tester-app',
};

exports.ENV = ENV;
function withRadioFaults(handlers, calls, file, queueFaultMetadata) {
  if (!file) return handlers;
  let armedStep, used = new Set();
  for (const fn of ['get', 'update', 'getKeys', 'createKeys', 'updateKeys', 'flushQueue', 'enqueue']) {
    const handle = handlers[fn];
    if (!handle) continue;
    handlers[fn] = (call, callback) => {
      let input;
      try { input = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (input) {
        if (armedStep !== input.id) {
          armedStep = input.id;
          used.clear();
        }
        const request = call.request;
        const item = request.getQueueItem?.();
        const eui = (request.getDevEui?.() || request.getDeviceKeys?.()?.getDevEui() || request.getDevice?.()?.getDevEui() || item?.getDevEui() || '').toUpperCase();
        const index = input.faults.findIndex((fault, i) => fault.rpc === fn && fault.eui === eui && !used.has(i));
        if (index !== -1) {
          used.add(index);
          const { code, details, delayMs } = input.faults[index];
          const frame = item ? { port: item.getFPort(), hex: Buffer.from(item.getData_asU8()).toString('hex') } : {};
          calls.push({ fn: fn === 'flushQueue' ? 'flush' : fn, eui, ...frame, injectedFault: delayMs ? { delayMs } : { code, details } });
          if (!delayMs) {
            const metadata = fn === 'flushQueue' || fn === 'enqueue' ? queueFaultMetadata?.() : undefined;
            return callback(metadata ? { code, details, metadata } : { code, details });
          }
          // A timed-out update must not write to the fake after cancellation.
          const timer = setTimeout(() => {
            if (!call.cancelled) handle(call, callback);
          }, delayMs);
          call.once('cancelled', () => clearTimeout(timer));
          return;
        }
      }
      return handle(call, callback);
    };
  }
  return handlers;
}
exports.withRadioFaults = withRadioFaults;

exports.start = async function (state, load = require) {
  const grpc = load('@grpc/grpc-js');
  const { DeviceServiceService } = load('@chirpstack/chirpstack-api/api/device_grpc_pb');
  const devicePb = load('@chirpstack/chirpstack-api/api/device_pb');
  const { TenantServiceService } = load('@chirpstack/chirpstack-api/api/tenant_grpc_pb');
  const tenantPb = load('@chirpstack/chirpstack-api/api/tenant_pb');
  const { ApplicationServiceService } = load('@chirpstack/chirpstack-api/api/application_grpc_pb');
  const applicationPb = load('@chirpstack/chirpstack-api/api/application_pb');
  const { DeviceProfileServiceService } = load('@chirpstack/chirpstack-api/api/device_profile_grpc_pb');
  const profilePb = load('@chirpstack/chirpstack-api/api/device_profile_pb');
  const { GatewayServiceService } = load('@chirpstack/chirpstack-api/api/gateway_grpc_pb');
  const gatewayPb = load('@chirpstack/chirpstack-api/api/gateway_pb');
  const { Empty } = load('google-protobuf/google/protobuf/empty_pb');
  const commonPb = load('@chirpstack/chirpstack-api/common/common_pb');

  state.cs.devices = state.cs.devices || {};
  state.cs.keys = state.cs.keys || {};

  const notFound = (details) => ({ code: grpc.status.NOT_FOUND, details, message: details });
  const alreadyExists = (details) => ({ code: grpc.status.ALREADY_EXISTS, details, message: details });
  const eui = (v) => String(v || '').toUpperCase();

  function seed() {
    const tenant = new tenantPb.Tenant();
    tenant.setId(TENANT_ID);
    tenant.setName('Open Smart Irrigation');
    tenant.setDescription('OSI smoke-test tenant (synthetic)');
    tenant.setCanHaveGateways(true);
    state.cs.tenant = tenant;

    state.cs.applications = [];
    for (const [key, id] of Object.entries(APP_IDS)) {
      const app = new applicationPb.Application();
      app.setId(id);
      app.setTenantId(TENANT_ID);
      app.setName('synthetic-' + key + '-application');
      state.cs.applications.push(app);
    }

    const names = {
      KIWI_SENSOR: 'kiwi', STREGA_VALVE: 'strega-gen1', DRAGINO_LSN50: 'lsn50',
      TEKTELIC_CLOVER: 'clover', SENSECAP_S2120: 's2120', AQUASCOPE_LORAIN: 'lorain',
      MILESIGHT_UC512: 'uc512', DRAGINO_SDI12: 'sdi12', RAK10701_FIELD_TESTER: 'rak10701',
      STREGA_VALVE_GEN2: 'strega-gen2',
    };
    state.cs.profiles = [];
    for (const [type, id] of Object.entries(PROFILE_IDS)) {
      const profile = new profilePb.DeviceProfile();
      profile.setId(id);
      profile.setTenantId(TENANT_ID);
      profile.setName('synthetic-' + names[type] + '-profile');
      profile.setRegion(commonPb.Region.EU868);
      profile.setMacVersion(commonPb.MacVersion.LORAWAN_1_0_3);
      profile.setRegParamsRevision(commonPb.RegParamsRevision.RP002_1_0_3);
      profile.setAdrAlgorithmId('default');
      profile.setSupportsOtaa(true);
      profile.setFlushQueueOnActivate(true);
      profile.setUplinkInterval(3600);
      state.cs.profiles.push(profile);
    }

    const gateway = new gatewayPb.Gateway();
    gateway.setGatewayId(GATEWAY_ID);
    gateway.setName('synthetic smoke gateway');
    gateway.setTenantId(TENANT_ID);
    state.cs.gateway = gateway;
  }
  seed();

  function page(items, request) {
    const limit = Number(request.getLimit()) || 0;
    const offset = Number(request.getOffset()) || 0;
    return limit > 0 ? items.slice(offset, offset + limit) : items.slice(offset);
  }

  // ChirpStack's List*Response messages carry *ListItem entries, not the full
  // entities; the list handlers below project the seeded state into them.
  const tenantItem = () => {
    const item = new tenantPb.TenantListItem();
    item.setId(state.cs.tenant.getId());
    item.setName(state.cs.tenant.getName());
    item.setCanHaveGateways(state.cs.tenant.getCanHaveGateways());
    return item;
  };
  const applicationItem = (app) => {
    const item = new applicationPb.ApplicationListItem();
    item.setId(app.getId());
    item.setName(app.getName());
    return item;
  };
  const profileItem = (profile) => {
    const item = new profilePb.DeviceProfileListItem();
    item.setId(profile.getId());
    item.setName(profile.getName());
    item.setRegion(profile.getRegion());
    item.setMacVersion(profile.getMacVersion());
    item.setRegParamsRevision(profile.getRegParamsRevision());
    item.setSupportsOtaa(profile.getSupportsOtaa());
    return item;
  };
  const gatewayItem = () => {
    const item = new gatewayPb.GatewayListItem();
    item.setGatewayId(state.cs.gateway.getGatewayId());
    item.setTenantId(state.cs.gateway.getTenantId());
    item.setName(state.cs.gateway.getName());
    return item;
  };

  const server = new grpc.Server();
  server.addService(DeviceServiceService, withRadioFaults({
    // The queue quartet matches scripts/fixtures/release-smoke/radio.js
    // exactly: same records, same random queue ids, same latency hook.
    enqueue(call, callback) {
      const item = call.request.getQueueItem();
      item.setId(randomUUID());
      const devEui = item.getDevEui().toUpperCase();
      (state.cs.queue[devEui] ||= []).push(item);
      state.cs.calls.push({ fn:'enqueue', eui: devEui, port:item.getFPort(), hex:Buffer.from(item.getData_asU8()).toString('hex'), id:item.getId(),expiresAt:item.getExpiresAt()?.toDate().toISOString()||null });
      const response = new devicePb.EnqueueDeviceQueueItemResponse(); response.setId(item.getId());
      if (state.cs.latencyMs) setTimeout(() => callback(null, response), state.cs.latencyMs);
      else callback(null,response);
    },
    getQueue(call,callback) {
      const response=new devicePb.GetDeviceQueueItemsResponse();response.setResultList(state.cs.queue[call.request.getDevEui().toUpperCase()]||[]);callback(null,response);
    },
    flushQueue(call,callback) {const devEui=call.request.getDevEui().toUpperCase();state.cs.calls.push({fn:'flush',eui:devEui});state.cs.queue[devEui]=[];callback(null,new Empty());},
    delete(call,callback) {
      const devEui=call.request.getDevEui().toUpperCase();
      state.cs.calls.push({fn:'delete',eui:devEui});
      delete state.cs.devices[devEui]; delete state.cs.keys[devEui]; state.cs.queue[devEui]=[];
      callback(null,new Empty());
    },
    get(call, callback) {
      const devEui = eui(call.request.getDevEui());
      state.cs.calls.push({ fn: 'get', eui: devEui });
      const device = state.cs.devices[devEui];
      if (!device) return callback(notFound('device ' + devEui + ' not found'));
      const response = new devicePb.GetDeviceResponse();
      response.setDevice(device);
      callback(null, response);
    },
    create(call, callback) {
      const device = call.request.getDevice();
      const devEui = eui(device.getDevEui());
      if (state.cs.devices[devEui]) return callback(alreadyExists('device ' + devEui + ' already exists'));
      state.cs.devices[devEui] = device;
      state.cs.calls.push({ fn: 'create', eui: devEui, name: device.getName(), applicationId: device.getApplicationId(), deviceProfileId: device.getDeviceProfileId() });
      callback(null, new Empty());
    },
    update(call, callback) {
      const device = call.request.getDevice();
      const devEui = eui(device.getDevEui());
      if (!state.cs.devices[devEui]) return callback(notFound('device ' + devEui + ' not found'));
      state.cs.devices[devEui] = device;
      state.cs.calls.push({ fn: 'update', eui: devEui, name: device.getName(), deviceProfileId: device.getDeviceProfileId() });
      callback(null, new Empty());
    },
    getKeys(call, callback) {
      const devEui = eui(call.request.getDevEui());
      state.cs.calls.push({ fn: 'getKeys', eui: devEui });
      const keys = state.cs.keys[devEui];
      if (!keys) return callback(notFound('device keys for ' + devEui + ' not found'));
      const response = new devicePb.GetDeviceKeysResponse();
      response.setDeviceKeys(keys);
      callback(null, response);
    },
    createKeys(call, callback) {
      const keys = call.request.getDeviceKeys();
      const devEui = eui(keys.getDevEui());
      if (state.cs.keys[devEui]) return callback(alreadyExists('device keys for ' + devEui + ' already exist'));
      state.cs.keys[devEui] = keys;
      state.cs.calls.push({ fn: 'createKeys', eui: devEui, nwkKey: keys.getNwkKey() });
      callback(null, new Empty());
    },
    updateKeys(call, callback) {
      const keys = call.request.getDeviceKeys();
      const devEui = eui(keys.getDevEui());
      if (!state.cs.keys[devEui]) return callback(notFound('device keys for ' + devEui + ' not found'));
      state.cs.keys[devEui] = keys;
      state.cs.calls.push({ fn: 'updateKeys', eui: devEui, nwkKey: keys.getNwkKey() });
      callback(null, new Empty());
    },
  }, state.cs.calls, process.env.TMPDIR && path.join(process.env.TMPDIR, 'radio-fault.json'), () => {
    // Node echoes the HTTP/2 Date header in a flush failure's response body.
    // Give injected queue failures a stable wire value for oracle self-replay.
    const metadata = new grpc.Metadata();
    metadata.set('date', 'Thu, 01 Jan 1970 00:00:00 GMT');
    return metadata;
  }));
  server.addService(TenantServiceService, {
    list(call, callback) {
      state.cs.calls.push({ fn: 'tenantList' });
      const response = new tenantPb.ListTenantsResponse();
      const items = page([tenantItem()], call.request);
      response.setTotalCount(1);
      response.setResultList(items);
      callback(null, response);
    },
    get(call, callback) {
      const id = call.request.getId();
      state.cs.calls.push({ fn: 'tenantGet', id });
      if (id !== TENANT_ID) return callback(notFound('tenant ' + id + ' not found'));
      const response = new tenantPb.GetTenantResponse();
      response.setTenant(state.cs.tenant);
      callback(null, response);
    },
    create(call, callback) {
      const tenant = call.request.getTenant();
      const id = randomUUID();
      tenant.setId(id);
      state.cs.calls.push({ fn: 'tenantCreate', name: tenant.getName(), id });
      const response = new tenantPb.CreateTenantResponse();
      response.setId(id);
      callback(null, response);
    },
  });
  server.addService(ApplicationServiceService, {
    list(call, callback) {
      const tenantId = call.request.getTenantId();
      state.cs.calls.push({ fn: 'applicationList', tenantId });
      const response = new applicationPb.ListApplicationsResponse();
      const items = page(state.cs.applications.filter((a) => !tenantId || a.getTenantId() === tenantId), call.request).map(applicationItem);
      response.setTotalCount(state.cs.applications.length);
      response.setResultList(items);
      callback(null, response);
    },
    get(call, callback) {
      const id = call.request.getId();
      state.cs.calls.push({ fn: 'applicationGet', id });
      const app = state.cs.applications.find((a) => a.getId() === id);
      if (!app) return callback(notFound('application ' + id + ' not found'));
      const response = new applicationPb.GetApplicationResponse();
      response.setApplication(app);
      callback(null, response);
    },
    create(call, callback) {
      const app = call.request.getApplication();
      const id = randomUUID();
      app.setId(id);
      state.cs.applications.push(app);
      state.cs.calls.push({ fn: 'applicationCreate', name: app.getName(), tenantId: app.getTenantId(), id });
      const response = new applicationPb.CreateApplicationResponse();
      response.setId(id);
      callback(null, response);
    },
  });
  server.addService(DeviceProfileServiceService, {
    list(call, callback) {
      const tenantId = call.request.getTenantId();
      state.cs.calls.push({ fn: 'profileList', tenantId });
      const response = new profilePb.ListDeviceProfilesResponse();
      const items = page(state.cs.profiles.filter((p) => !tenantId || p.getTenantId() === tenantId), call.request).map(profileItem);
      response.setTotalCount(state.cs.profiles.length);
      response.setResultList(items);
      callback(null, response);
    },
    get(call, callback) {
      const id = call.request.getId();
      state.cs.calls.push({ fn: 'profileGet', id });
      const profile = state.cs.profiles.find((p) => p.getId() === id);
      if (!profile) return callback(notFound('device profile ' + id + ' not found'));
      const response = new profilePb.GetDeviceProfileResponse();
      response.setDeviceProfile(profile);
      callback(null, response);
    },
    create(call, callback) {
      const profile = call.request.getDeviceProfile();
      const id = randomUUID();
      profile.setId(id);
      state.cs.profiles.push(profile);
      state.cs.calls.push({ fn: 'profileCreate', name: profile.getName(), tenantId: profile.getTenantId(), id });
      const response = new profilePb.CreateDeviceProfileResponse();
      response.setId(id);
      callback(null, response);
    },
    update(call, callback) {
      const profile = call.request.getDeviceProfile();
      const id = profile.getId();
      const index = state.cs.profiles.findIndex((p) => p.getId() === id);
      if (index < 0) return callback(notFound('device profile ' + id + ' not found'));
      state.cs.profiles[index] = profile;
      state.cs.calls.push({ fn: 'profileUpdate', id, name: profile.getName() });
      callback(null, new Empty());
    },
  });
  server.addService(GatewayServiceService, {
    list(call, callback) {
      const tenantId = call.request.getTenantId();
      state.cs.calls.push({ fn: 'gatewayList', tenantId });
      const response = new gatewayPb.ListGatewaysResponse();
      const items = (!tenantId || state.cs.gateway.getTenantId() === tenantId) ? [gatewayItem()] : [];
      response.setTotalCount(items.length);
      response.setResultList(items);
      callback(null, response);
    },
    get(call, callback) {
      const id = eui(call.request.getGatewayId());
      state.cs.calls.push({ fn: 'gatewayGet', id });
      if (id !== GATEWAY_ID) return callback(notFound('gateway ' + id + ' not found'));
      const response = new gatewayPb.GetGatewayResponse();
      response.setGateway(state.cs.gateway);
      callback(null, response);
    },
    update(call, callback) {
      const gateway = call.request.getGateway();
      const id = eui(gateway.getGatewayId());
      if (id !== GATEWAY_ID) return callback(notFound('gateway ' + id + ' not found'));
      state.cs.gateway = gateway;
      state.cs.calls.push({ fn: 'gatewayUpdate', id });
      callback(null, new Empty());
    },
  });
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => e ? reject(e) : resolve(p)));
  return { url: 'http://127.0.0.1:' + port, env: ENV, stop: () => new Promise((r) => server.tryShutdown(r)) };
};
