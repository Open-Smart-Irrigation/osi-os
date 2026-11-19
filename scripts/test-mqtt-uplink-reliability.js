'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

for (const profile of ['bcm2712', 'bcm2709']) {
  test(`${profile}: every uplink subscription uses QoS 1 on the persistent local session`, () => {
    const flows = JSON.parse(fs.readFileSync(path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`)));
    // Scan every MQTT input, so a newly added device cannot escape this guard.
    const inputs = flows.filter(n => n.type === 'mqtt in');
    assert.ok(inputs.length >= 10);
    for (const input of inputs) {
      assert.equal(input.topic, 'application/+/device/+/event/up', input.name);
      assert.equal(input.qos, '1', input.name);
      const broker = flows.find(n => n.id === input.broker);
      assert.equal(broker.broker, 'localhost');
      assert.equal(broker.clientid, 'nodered');
      assert.equal(broker.protocolVersion, '4');
      assert.equal(broker.cleansession, false);
      assert.equal(broker.autoUnsubscribe, false, 'shutdown must retain the broker subscription');
    }
  });
  test(`${profile}: broker queue holds a 60 second outage at 6 uplinks/s`, () => {
    const conf = fs.readFileSync(path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/etc/mosquitto/mosquitto.conf`), 'utf8');
    const options = Object.fromEntries(conf.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split(/\s+/)));
    assert.equal(Number(options.max_queued_messages), 1000);
    assert.equal(Number(options.max_queued_bytes), 16 * 1024 * 1024);
    assert.ok(Number(options.max_queued_messages) >= 60 * 6);
    assert.ok(Number(options.max_queued_bytes) >= 60 * 6 * 16 * 1024);
    assert.equal(options.persistence, 'false');
  });
}

test('image ChirpStack integration publishes at QoS 1', () => {
  const init = fs.readFileSync(path.join(root, 'feeds/chirpstack-openwrt-feed/chirpstack/chirpstack/files/chirpstack.init'), 'utf8');
  const integration = init.split('[integration.mqtt]')[1].split('EOF')[0];
  assert.match(integration, /^\s*qos\s*=\s*1\s*$/m);
  const deploy = fs.readFileSync(path.join(root,'deploy.sh'),'utf8');
  assert.ok(deploy.includes('"$MODULE_STAGE/osi-uplink-dedup-guard/durable.js"'), 'script deploy must stage the durable identity helper');
});

// Opt in under osi-heavy. This starts only a disposable, network-isolated
// local broker; no gateway, host port or pre-existing container is touched.
test('offline persistent session recovers 360 uplinks; replay inserts no second canonical row', {
  skip: process.env.OSI_MQTT_RESTART_TEST !== '1' && 'set OSI_MQTT_RESTART_TEST=1 under osi-heavy with local eclipse-mosquitto:2.0.22',
}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-mqtt-restart-'));
  fs.chmodSync(dir,0o755);
  const name = `osi-mqtt-restart-${process.pid}`;
  const run = (args, options = {}) => spawnSync('podman', args, {encoding:'utf8', timeout:20000, ...options});
  const success = (args, options) => {
    const result = run(args, options);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.error || result.stdout}`);
    return result.stdout;
  };
  t.after(() => { run(['rm','-f',name]); fs.rmSync(dir,{recursive:true,force:true}); });
  const config = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/mosquitto/mosquitto.conf');
  fs.copyFileSync(config, path.join(dir,'mosquitto.conf'));
  success(['run','--rm','-d','--pull=never','--name',name,'--network=none',
    '-v',`${dir}:/mosquitto/config:ro,Z`,'--entrypoint','/usr/sbin/mosquitto',
    'docker.io/library/eclipse-mosquitto:2.0.22','-c','/mosquitto/config/mosquitto.conf']);
  success(['exec',name,'sh','-c',
    'for i in 1 2 3 4 5 6 7 8 9 10; do mosquitto_pub -h localhost -t test/ready -m ready && exit 0; sleep 0.1; done; exit 1']);
  const topic = 'application/test/device/A840410000000001/event/up';
  const subscription = 'application/+/device/+/event/up';
  // -c retains the session when this first subscriber exits. SUBACK in its
  // debug output proves the broker registered the subscription before outage.
  const subscribed = run(['exec',name,'mosquitto_sub','-h','localhost','-V','mqttv311','-i','nodered','-c','-q','1','-t',subscription,'-W','2','-d']);
  assert.equal(subscribed.status,27,subscribed.stderr);
  assert.match(subscribed.stdout,/SUBACK/);
  const events = Array.from({length:360}, (_,fCnt) => ({
    deduplicationId:`restart-${fCnt}`,fCnt,time:'2026-11-19T10:00:00Z',
    deviceInfo:{devEui:'A840410000000001'},object:{ambient_temperature:fCnt},
    padding:'x'.repeat(16000)
  }));
  // The first event is deliberately republished: MQTT QoS 1 is at-least-once.
  const sent = [...events,events[0]];
  success(['exec','-i',name,'mosquitto_pub','-h','localhost','-V','mqttv311','-q','1','-t',topic,'-l'],
    {input:sent.map(event=>JSON.stringify(event)).join('\n')+'\n',maxBuffer:1024*1024});
  const received = success(['exec',name,'mosquitto_sub','-h','localhost','-V','mqttv311','-i','nodered','-c','-q','1','-t',subscription,'-C','361','-W','10'],
    {maxBuffer:16*1024*1024}).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(received.length,361);
  assert.deepEqual(new Set(received.map(event=>event.deduplicationId)),new Set(events.map(event=>event.deduplicationId)));
  const { DatabaseSync } = require('node:sqlite');
  const nr = path.join(root,'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
  const writer = require(path.join(nr,'osi-device-writer'));
  const db = new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.exec('CREATE TABLE device_data(id INTEGER PRIMARY KEY,deveui TEXT,recorded_at TEXT,ambient_temperature REAL,uplink_key TEXT); CREATE UNIQUE INDEX uq_device_data_uplink ON device_data(deveui,uplink_key);');
  writer.resetColumnCache();
  for (const event of received) writer.writeDeviceData(db,[{key:'ambient_temperature',edgeField:'ambient_temperature'}],
    {recordedAt:event.time,channels:event.object}, {deveui:event.deviceInfo.devEui,uplinkKey:writer.eventKey('uc512',event)});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_data').get().n,360);
  t.diagnostic('361 queued deliveries, 360 unique identities, 360 canonical rows');
});
