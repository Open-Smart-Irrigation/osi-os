#!/usr/bin/env node
// Patch flows.json to add LSN50 dendrometer simulation nodes
'use strict';
const fs = require('fs');
const path = require('path');

const FLOWS_PATH = path.join(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));

// ── Remove any previously patched sim-dendro nodes ─────────────────────────
const SIM_IDS = [
  'lsn50-sim-link-in',
  'dendro-live-sim-tab',
  'sim-dendro-inject-live', 'sim-dendro-fn-live', 'sim-dendro-link-out',
  'sim-dendro-inject-setup', 'sim-dendro-fn-setup', 'sim-dendro-debug-live',
  'sim-dendro-debug-setup',
];
for (let i = flows.length - 1; i >= 0; i--) {
  if (SIM_IDS.includes(flows[i].id)) flows.splice(i, 1);
}

// ── Helper ─────────────────────────────────────────────────────────────────
const SIM_TAB = 'a88bb648cac221ce';   // disabled Simulations (Dev) tab
const LIVE_TAB = 'dendro-live-sim-tab'; // new enabled tab for live dendro sim
const LSN50_TAB = 'lsn50-tab';

// ── 0. New enabled tab for live dendro simulation ──────────────────────────
flows.push({
  id: LIVE_TAB,
  type: 'tab',
  label: 'Dendro Live Sim',
  disabled: false,
  info: '8-tree dendrometer live simulation — 4 control reference + 4 monitored irrigated trees',
});

// ── 1. Link-in node in lsn50-tab ──────────────────────────────────────────
flows.push({
  id: 'lsn50-sim-link-in',
  type: 'link in',
  z: LSN50_TAB,
  name: 'LSN50 SIM IN',
  links: ['sim-dendro-link-out'],
  x: 140, y: 460,
  wires: [['lsn50-decode-fn']],
});

// ── 2. Live inject (10 min) ────────────────────────────────────────────────
flows.push({
  id: 'sim-dendro-inject-live',
  type: 'inject',
  z: LIVE_TAB,
  name: 'LSN50 DENDRO LIVE – 10min',
  props: [{ p: 'payload' }],
  repeat: '600',
  crontab: '',
  once: true,
  onceDelay: 2,
  topic: '',
  payload: '',
  payloadType: 'date',
  x: 200, y: 400,
  wires: [['sim-dendro-fn-live']],
});

// ── 3. Live uplink generator — writes directly to DB via sqlite3 ───────────
const liveFn = `
// DENDRO TREE UPLINK SIM — 8 LSN50 trees, fires every 10 min
// Writes device_data + dendrometer_readings directly via sqlite3
// (bypasses MQTT pipeline to avoid SQLite concurrency issues)
//
// 4 control reference trees (is_reference_tree=1): stable, small MDS baseline
// 4 monitored irrigated trees (is_reference_tree=0): amplitude grows with stress

return (async () => {
  const REF_AMP = 80; // µm — reference tree baseline amplitude

  const TREES = [
    { key: 'sim_ctl_01', baseMm: 14.8, ampUm: REF_AMP, ampGrowUmDay: 0,   growUmDay:  5 },
    { key: 'sim_ctl_02', baseMm: 15.5, ampUm: REF_AMP, ampGrowUmDay: 0,   growUmDay:  4 },
    { key: 'sim_ctl_03', baseMm: 13.2, ampUm: REF_AMP, ampGrowUmDay: 0,   growUmDay:  6 },
    { key: 'sim_ctl_04', baseMm: 16.8, ampUm: REF_AMP, ampGrowUmDay: 0,   growUmDay:  3 },
    { key: 'sim_irr_01', baseMm: 14.0, ampUm: REF_AMP, ampGrowUmDay: 0,   growUmDay: 15 },
    { key: 'sim_irr_02', baseMm: 15.2, ampUm: REF_AMP, ampGrowUmDay: 0.5, growUmDay: 12 },
    { key: 'sim_irr_03', baseMm: 13.5, ampUm: REF_AMP, ampGrowUmDay: 0.9, growUmDay: 18 },
    { key: 'sim_irr_04', baseMm: 16.0, ampUm: REF_AMP, ampGrowUmDay: 1.6, growUmDay: 10 },
  ];

  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function makeDevEui(name) {
    const h1 = hash32('A|'+name), h2 = hash32('B|'+name);
    const h3 = hash32('C|'+name), h4 = hash32('D|'+name);
    return ((h1^(h3>>>1))>>>0).toString(16).padStart(8,'0').toUpperCase() +
           ((h2^(h4>>>1))>>>0).toString(16).padStart(8,'0').toUpperCase();
  }

  const EPOCH_MS = (() => {
    const d = new Date(Date.now() - 30 * 86400000);
    d.setUTCHours(0,0,0,0);
    return d.getTime();
  })();

  function getPosUm(tree, nowMs) {
    const elapsed  = (nowMs - EPOCH_MS) / 1000;
    const dayFrac  = elapsed / 86400;
    const hourFrac = (elapsed % 86400) / 3600;
    const growth   = tree.growUmDay * dayFrac;
    const effAmp   = tree.ampUm + (tree.ampGrowUmDay || 0) * dayFrac;
    let diurnal = 0;
    if (hourFrac >= 6 && hourFrac <= 18)
      diurnal = effAmp * Math.sin(Math.PI * (hourFrac - 6) / 12);
    const noise = 8 * Math.sin(elapsed * 0.017) + 5 * Math.sin(elapsed * 0.071);
    return Math.round(tree.baseMm * 1000 + growth - diurnal + noise);
  }

  function n(v) { return (v===null||v===undefined||!isFinite(Number(v))) ? 'NULL' : String(Number(v)); }
  function s(v) { return (v===null||v===undefined) ? 'NULL' : "'"+String(v).replace(/'/g,"''")+"'"; }

  const _db  = new sqlite3.Database('/data/db/farming.db');
  const exec = sql => new Promise((res,rej) => _db.run(sql, e => e ? rej(e) : res()));
  const close = () => new Promise(res => _db.close(() => res()));

  try {
    const now   = new Date();
    const nowMs = now.getTime();
    const ts    = now.toISOString();
    const tempC = 18 + 8 * Math.sin(Math.PI * (now.getUTCHours() - 6) / 12);

    for (const tree of TREES) {
      const deveui = makeDevEui(tree.key);
      const posUm  = getPosUm(tree, nowMs);
      const isValid = (posUm >= 0 && posUm <= 26000) ? 1 : 0;
      const posMm  = posUm / 1000;
      const adcV   = Math.max(0, Math.min(2.6, posMm / 10));
      const batV   = 3.39 + Math.sin(nowMs / 7200000 + deveui.charCodeAt(0)) * 0.02;

      // Insert device_data (last-seen record)
      await exec(
        'INSERT INTO device_data(deveui,ext_temperature_c,bat_v,adc_ch0v,dendro_position_mm,dendro_valid,dendro_delta_mm,recorded_at) VALUES('+
        s(deveui)+','+n(Math.round(tempC*10)/10)+','+n(Math.round(batV*1000)/1000)+','+
        n(Math.round(adcV*1000)/1000)+','+n(Math.round(posMm*1000)/1000)+','+n(isValid)+',NULL,'+s(ts)+')'
      );

      // Insert dendrometer_readings
      await exec(
        'INSERT OR IGNORE INTO dendrometer_readings(deveui,position_um,adc_v,is_valid,is_outlier,recorded_at) VALUES('+
        s(deveui)+','+n(posUm)+','+n(Math.round(adcV*1000)/1000)+','+n(isValid)+',0,'+s(ts)+')'
      );
    }

    await close();
    node.status({ fill: 'green', shape: 'dot', text: 'SIM x8 @ ' + ts.slice(11,19) });
    msg.payload = { simulated: 8, ts };
    return msg;
  } catch(err) {
    node.error('DENDRO SIM LIVE ERROR: ' + err.message);
    node.status({ fill: 'red', shape: 'ring', text: err.message.slice(0,40) });
    try { await close(); } catch(e) {}
    return null;
  }
})();
`.trim();

flows.push({
  id: 'sim-dendro-fn-live',
  type: 'function',
  z: LIVE_TAB,
  name: 'DENDRO TREE UPLINK SIM',
  func: liveFn,
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [{ var: 'sqlite3', module: 'sqlite3' }],
  x: 470, y: 400,
  wires: [['sim-dendro-debug-live']],
});

// ── 4. Debug for live sim ─────────────────────────────────────────────────
flows.push({
  id: 'sim-dendro-debug-live',
  type: 'debug',
  z: LIVE_TAB,
  name: 'Live Sim Status',
  active: true,
  tosidebar: true,
  complete: 'payload',
  targetType: 'msg',
  statusVal: '',
  statusType: 'auto',
  x: 710, y: 400,
  wires: [],
});

// ── 5. Setup inject (manual) ───────────────────────────────────────────────
flows.push({
  id: 'sim-dendro-inject-setup',
  type: 'inject',
  z: SIM_TAB,
  name: 'DENDRO SIM SETUP (run once)',
  props: [{ p: 'payload' }],
  repeat: '',
  crontab: '',
  once: false,
  onceDelay: 0,
  topic: '',
  payload: '',
  payloadType: 'date',
  x: 220, y: 500,
  wires: [['sim-dendro-fn-setup']],
});

// ── 6. Setup / backfill function ──────────────────────────────────────────
const setupFn = `
// DENDRO SIM SETUP
// 1. Upsert 8 sim LSN50 devices into user 1's account, zone "Sim Zone A"
// 2. Backfill 30 days of dendrometer_readings (every 10 min per device)
// 3. Compute dendro_daily for each day using the analytics algorithm
// 4. Compute zone_daily_recommendations for each day
//
// Safe to re-run: devices/readings use INSERT OR IGNORE or INSERT OR REPLACE.

return (async () => {
  const DB_PATH = '/data/db/farming.db';
  const _db = new sqlite3.Database(DB_PATH);
  const q    = sql => new Promise((res,rej) => _db.all(sql, (e,r) => e ? rej(e) : res(r||[])));
  const exec = sql => new Promise((res,rej) => _db.run(sql,  e   => e ? rej(e) : res()));
  const close = ()  => new Promise(res => _db.close(() => res()));

  function n(v) { return (v===null||v===undefined||!isFinite(Number(v))) ? 'NULL' : String(Number(v)); }
  function s(v) { return (v===null||v===undefined) ? 'NULL' : "'"+String(v).replace(/'/g,"''")+"'"; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── Tree definitions ────────────────────────────────────────────────────
  const TREES = [
    // Irrigated (dendro_enabled=1, is_reference_tree=0)
    { key:'sim_irr_01', displayName:'Sim Irrigated 1', baseMm:14.0, ampUm: 50,  growUmDay:15, stressUmDay: 0, isRef:0 },
    { key:'sim_irr_02', displayName:'Sim Irrigated 2', baseMm:15.2, ampUm: 60,  growUmDay:12, stressUmDay: 0, isRef:0 },
    { key:'sim_irr_03', displayName:'Sim Irrigated 3', baseMm:13.5, ampUm: 45,  growUmDay:18, stressUmDay: 0, isRef:0 },
    { key:'sim_irr_04', displayName:'Sim Irrigated 4', baseMm:16.0, ampUm: 55,  growUmDay:10, stressUmDay: 0, isRef:0 },
    // Control / reference (dendro_enabled=1, is_reference_tree=1)
    { key:'sim_ctl_01', displayName:'Sim Control 1',   baseMm:14.8, ampUm:140,  growUmDay: 5, stressUmDay: 3, isRef:1 },
    { key:'sim_ctl_02', displayName:'Sim Control 2',   baseMm:15.5, ampUm:160,  growUmDay: 4, stressUmDay: 4, isRef:1 },
    { key:'sim_ctl_03', displayName:'Sim Control 3',   baseMm:13.2, ampUm:120,  growUmDay: 6, stressUmDay: 2, isRef:1 },
    { key:'sim_ctl_04', displayName:'Sim Control 4',   baseMm:16.8, ampUm:150,  growUmDay: 3, stressUmDay: 5, isRef:1 },
  ];

  // ── DevEUI generator (same hash as live sim) ────────────────────────────
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function makeDevEui(name) {
    const h1 = hash32('A|'+name), h2 = hash32('B|'+name);
    const h3 = hash32('C|'+name), h4 = hash32('D|'+name);
    return ((h1^(h3>>>1))>>>0).toString(16).padStart(8,'0').toUpperCase() +
           ((h2^(h4>>>1))>>>0).toString(16).padStart(8,'0').toUpperCase();
  }
  TREES.forEach(t => { t.deveui = makeDevEui(t.key); });

  // ── Position model ──────────────────────────────────────────────────────
  // Same as live sim: base + growth – diurnal – stressDrift + noise
  const EPOCH_MS = (() => {
    const d = new Date(Date.now() - 30 * 86400000);
    d.setUTCHours(0,0,0,0);
    return d.getTime();
  })();

  function getPosUm(tree, timestampMs) {
    const elapsed  = (timestampMs - EPOCH_MS) / 1000;
    const dayFrac  = elapsed / 86400;
    const hourFrac = (elapsed % 86400) / 3600;
    const growth   = tree.growUmDay  * dayFrac;
    const stress   = tree.stressUmDay * dayFrac;
    let diurnal = 0;
    if (hourFrac >= 6 && hourFrac <= 18)
      diurnal = tree.ampUm * Math.sin(Math.PI * (hourFrac - 6) / 12);
    const noise = 8 * Math.sin(elapsed * 0.017) + 5 * Math.sin(elapsed * 0.071);
    return Math.round(tree.baseMm * 1000 + growth - diurnal - stress + noise);
  }

  try {
    node.status({ fill:'yellow', shape:'ring', text:'Setting up devices…' });

    // ── 1. Ensure user 1 exists, get their ID ──────────────────────────────
    const users = await q("SELECT id FROM users ORDER BY id ASC LIMIT 1");
    if (!users.length) throw new Error('No users in DB');
    const userId = users[0].id;

    // ── 2. Create or find "Sim Zone A" zone ────────────────────────────────
    const existingZone = await q(
      "SELECT id FROM irrigation_zones WHERE user_id="+userId+" AND name='Sim Zone A' AND deleted_at IS NULL LIMIT 1"
    );
    let zoneId;
    if (existingZone.length) {
      zoneId = existingZone[0].id;
      node.log('Using existing zone id=' + zoneId);
    } else {
      const now = new Date().toISOString();
      await exec("INSERT INTO irrigation_zones(name,user_id,created_at,updated_at) VALUES('Sim Zone A',"+userId+",'"+now+"','"+now+"')");
      const newZone = await q("SELECT id FROM irrigation_zones WHERE user_id="+userId+" AND name='Sim Zone A' ORDER BY id DESC LIMIT 1");
      zoneId = newZone[0].id;
      node.log('Created zone id=' + zoneId);
    }

    // ── 3. Register devices ────────────────────────────────────────────────
    const LSN50_APP_ID = '22f61e5c-d89b-4222-839f-3d72a302fc2e';
    for (const tree of TREES) {
      const existing = await q("SELECT deveui FROM devices WHERE deveui="+s(tree.deveui)+" LIMIT 1");
      if (!existing.length) {
        const now = new Date().toISOString();
        await exec(
          "INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,dendro_enabled,temp_enabled,is_reference_tree,chirpstack_app_id,created_at,updated_at) VALUES("+
          s(tree.deveui)+","+s(tree.displayName)+",'DRAGINO_LSN50',"+userId+","+zoneId+",1,1,"+tree.isRef+","+s(LSN50_APP_ID)+",'"+now+"','"+now+"')"
        );
        node.log('Registered device ' + tree.deveui + ' ' + tree.displayName);
      } else {
        // Ensure assigned to this zone with correct flags
        const now = new Date().toISOString();
        await exec(
          "UPDATE devices SET irrigation_zone_id="+zoneId+",dendro_enabled=1,temp_enabled=1,is_reference_tree="+tree.isRef+",updated_at='"+now+"' WHERE deveui="+s(tree.deveui)
        );
      }
    }

    // ── 4. Backfill dendrometer_readings ───────────────────────────────────
    node.status({ fill:'yellow', shape:'ring', text:'Inserting readings…' });
    const STEP_MS  = 10 * 60 * 1000; // 10 minutes
    const DAYS     = 30;
    const TOTAL_MS = DAYS * 86400000;

    // Build batch inserts (1000 rows per transaction per device)
    for (const tree of TREES) {
      // Delete old sim readings for this device (clean re-run)
      await exec("DELETE FROM dendrometer_readings WHERE deveui="+s(tree.deveui));

      const rows = [];
      for (let t = EPOCH_MS; t < EPOCH_MS + TOTAL_MS; t += STEP_MS) {
        const posUm = getPosUm(tree, t);
        const isValid = (posUm >= 0 && posUm <= 26000) ? 1 : 0;
        const ts = new Date(t).toISOString();
        rows.push("("+s(tree.deveui)+","+n(posUm)+",NULL,"+n(isValid)+",0,'"+ts+"')");
      }

      // Insert in chunks of 500
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        await exec(
          "INSERT OR IGNORE INTO dendrometer_readings(deveui,position_um,adc_v,is_valid,is_outlier,recorded_at) VALUES "+
          chunk.join(',')
        );
      }
      node.log('Inserted '+rows.length+' readings for '+tree.deveui);
    }

    // ── 5. Compute dendro_daily + zone_recommendations for each day ────────
    node.status({ fill:'yellow', shape:'ring', text:'Computing analytics…' });

    // Clear old sim analytics
    for (const tree of TREES) {
      await exec("DELETE FROM dendrometer_daily WHERE deveui="+s(tree.deveui));
    }
    await exec("DELETE FROM zone_daily_recommendations WHERE zone_id="+zoneId);

    const RANK = { none:0, mild:1, moderate:2, significant:3, severe:4 };
    const NOISE = 30;

    function median3(vals) {
      return vals.map((_, i) => {
        const w = vals.slice(Math.max(0,i-1), Math.min(vals.length,i+2))
                      .filter(v => v!=null && isFinite(v)).sort((a,b) => a-b);
        return w.length ? w[Math.floor(w.length/2)] : null;
      });
    }
    function round(v, d) { return v==null ? null : Math.round(v*Math.pow(10,d))/Math.pow(10,d); }
    function classifyStress(si, tgrS, tgrH, twdH) {
      if (si!=null) {
        if (si<=1.0) return 'none'; if (si<=1.15) return 'mild';
        if (si<=1.25) return 'moderate'; if (si<=1.4) return 'significant';
        return 'severe';
      }
      if (tgrS==null) return 'none';
      if (tgrS < 0) return 'significant';
      if ((tgrH||[]).filter(t=>t!=null&&Math.abs(t)<=NOISE).length>=2) return 'moderate';
      if ((twdH||[]).length>=3) {
        const l=twdH.slice(-3);
        if (l.every((v,i)=>i===0||(v!=null&&l[i-1]!=null&&v>l[i-1]))) return 'significant';
      }
      if (Math.abs(tgrS)<=NOISE) return 'mild';
      return 'none';
    }
    function irrAction(h3, rain) {
      if (h3.includes('severe')) return { action:'emergency_irrigate', reasoning:'Severe stress — emergency irrigation' };
      const c={};
      for (const l of h3) c[l]=(c[l]||0)+1;
      let d='none';
      for (const [l,cnt] of Object.entries(c)) if (cnt>=2 && (RANK[l]||0)>(RANK[d]||0)) d=l;
      if (d==='none')        return { action:'decrease_10',  reasoning:'No stress ≥2 of last 3 days — reduce 10%' };
      if (d==='mild')        return { action:'maintain',     reasoning:'Mild stress ≥2 of last 3 days — maintain' };
      if (d==='moderate')    return rain ? { action:'maintain',    reasoning:'Moderate stress; rain suppresses increase' }
                                        : { action:'increase_10',  reasoning:'Moderate stress ≥2 of last 3 days — increase 10%' };
      if (d==='significant') return rain ? { action:'increase_10', reasoning:'Significant stress; rain limits to +10%' }
                                        : { action:'increase_20',  reasoning:'Significant stress ≥2 of last 3 days — increase 20%' };
      return { action:'maintain', reasoning:'Insufficient data — maintain' };
    }

    // Per-day analytics loop
    const dailyResults = {}; // keyed by deveui, array of day records (oldest first)
    TREES.forEach(t => { dailyResults[t.deveui] = []; });

    for (let d = 0; d < DAYS; d++) {
      const dayStart = new Date(EPOCH_MS + d * 86400000);
      const dayEnd   = new Date(EPOCH_MS + (d+1) * 86400000);
      const dateStr  = dayStart.toISOString().slice(0,10);
      const computedAt = dayEnd.toISOString();

      // Per-device compute
      const dayTrees = [];
      for (const tree of TREES) {
        const EUI = tree.deveui;
        const rows = await q(
          "SELECT position_um,is_valid,is_outlier FROM dendrometer_readings WHERE deveui="+s(EUI)+
          " AND recorded_at>='"+dayStart.toISOString()+"' AND recorded_at<'"+dayEnd.toISOString()+
          "' ORDER BY recorded_at ASC"
        );
        const vc = rows.filter(r=>r.is_valid===1&&r.is_outlier===0).length;
        const qual = rows.length<10 ? 'insufficient' : vc<80 ? 'unreliable' : 'good';
        const filt = median3(rows.map(r=>(r.is_valid===1&&r.is_outlier===0)?r.position_um:null))
                       .filter(v=>v!=null&&isFinite(v));

        if (!filt.length) {
          dayTrees.push({ deveui:EUI, is_ref:tree.isRef, d_max:null, d_min:null, mds:null,
                          tgr:null, tgrS:null, twd:null, dr:null, recD:null, si:null,
                          stress:'none', qual, vc });
          continue;
        }

        const dMax = Math.max(...filt), dMin = Math.min(...filt), mds = dMax - dMin;

        // History from already-computed days (oldest first in dailyResults)
        const hist = (dailyResults[EUI] || []).slice(-7).reverse(); // newest first
        const yest = hist[0] || null;
        const tgr  = (yest && yest.d_max!=null) ? round(dMax - yest.d_max, 0) : null;
        const prevT = hist.slice(0,2).map(r=>r.tgr).filter(v=>v!=null);
        const tgrAll = [tgr,...prevT].filter(v=>v!=null);
        const tgrS = tgrAll.length ? round(tgrAll.reduce((a,b)=>a+b,0)/tgrAll.length,0) : null;

        // Peak D_max for TWD (rolling 30-day window = all days so far)
        const allPrev = dailyResults[EUI] || [];
        const peak = allPrev.length
          ? Math.max(dMax, ...allPrev.map(r=>r.d_max).filter(v=>v!=null))
          : dMax;
        const twd = Math.max(0, round(peak - dMax, 0));

        const dr = (yest && yest.d_min!=null) ? round(dMax - yest.d_min, 0) : null;
        const drA = [dr,...hist.slice(0,6).map(r=>r.dr)].filter(v=>v!=null);
        const mA  = [mds,...hist.slice(0,6).map(r=>r.mds)].filter(v=>v!=null);
        const recD = (drA.length&&mA.length)
          ? round(drA.reduce((a,b)=>a+b)/drA.length - mA.reduce((a,b)=>a+b)/mA.length, 0)
          : null;

        dayTrees.push({ deveui:EUI, is_ref:tree.isRef, d_max:round(dMax,0), d_min:round(dMin,0),
                        mds:round(mds,0), tgr, tgrS, twd, dr, recD, si:null, stress:null, qual, vc });
      }

      // Compute SI (irrigated vs first control reference)
      const ref = dayTrees.find(t => t.is_ref && t.mds!=null && t.mds>0);
      for (const t of dayTrees) {
        if (ref && !t.is_ref && t.mds!=null) t.si = round(t.mds / ref.mds, 2);
      }

      // Classify stress + insert dendro_daily
      for (const t of dayTrees) {
        const prev = (dailyResults[t.deveui]||[]).slice(-3).reverse();
        const tgrH = prev.map(r=>r.tgrS);
        const twdH = prev.map(r=>r.twd);
        t.stress = classifyStress(t.si, t.tgrS, tgrH, twdH);

        await exec(
          "INSERT OR REPLACE INTO dendrometer_daily"+
          "(deveui,date,d_max_um,d_min_um,mds_um,tgr_um,tgr_smoothed_um,twd_um,dr_um,"+
          "recovery_delta_um,signal_intensity,stress_level,data_quality,valid_readings_count,computed_at)"+
          " VALUES("+s(t.deveui)+","+s(dateStr)+","+n(t.d_max)+","+n(t.d_min)+","+n(t.mds)+","+
          n(t.tgr)+","+n(t.tgrS)+","+n(t.twd)+","+n(t.dr)+","+n(t.recD)+","+n(t.si)+","+
          s(t.stress)+","+s(t.qual)+","+n(t.vc)+","+s(computedAt)+")"
        );

        // Accumulate for next-day lookups
        if (!dailyResults[t.deveui]) dailyResults[t.deveui] = [];
        dailyResults[t.deveui].push(t);
      }

      // Zone recommendation for this day
      const nonRef  = dayTrees.filter(t => !t.is_ref);
      const zoneSt  = nonRef.reduce((w,t) => (RANK[t.stress]||0)>(RANK[w]||0) ? t.stress : w, 'none');
      const zoneHist = []; // collect last 2 days zone stress
      // Look up previous zone recommendations from already-inserted rows
      const prevRecs = await q(
        "SELECT zone_stress_summary FROM zone_daily_recommendations WHERE zone_id="+zoneId+
        " AND date<"+s(dateStr)+" ORDER BY date DESC LIMIT 2"
      );
      const hist3 = [zoneSt, ...prevRecs.map(r=>r.zone_stress_summary)].slice(0,3);
      const { action, reasoning } = irrAction(hist3, false);

      await exec(
        "INSERT OR REPLACE INTO zone_daily_recommendations"+
        "(zone_id,date,zone_stress_summary,rainfall_mm,water_delivered_liters,irrigation_action,action_reasoning,recommendation_json,computed_at)"+
        " VALUES("+zoneId+","+s(dateStr)+","+s(zoneSt)+",0,0,"+s(action)+","+s(reasoning)+","+
        s(JSON.stringify({zone_id:zoneId,date:dateStr,zone_stress:zoneSt,action}))+","+s(computedAt)+")"
      );
    }

    await close();
    const msg2 = { payload: { success:true, zone_id:zoneId, devices:TREES.length, days:DAYS } };
    node.status({ fill:'green', shape:'dot', text:'Done — '+TREES.length+' devices, '+DAYS+' days' });
    node.log('Sim setup complete: zone '+zoneId+', '+TREES.length+' devices, '+DAYS+' days backfilled');
    return msg2;

  } catch(err) {
    node.error('DENDRO SIM SETUP ERROR: '+err.message+'\\n'+err.stack);
    node.status({ fill:'red', shape:'ring', text:err.message });
    try { await close(); } catch(e) {}
    return null;
  }
})();
`.trim();

flows.push({
  id: 'sim-dendro-fn-setup',
  type: 'function',
  z: SIM_TAB,
  name: 'DENDRO SIM SETUP',
  func: setupFn,
  outputs: 1,
  timeout: 60,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [{ var: 'sqlite3', module: 'sqlite3' }],
  x: 490, y: 500,
  wires: [['sim-dendro-debug-setup']],
});

// ── 7. Debug output for setup ─────────────────────────────────────────────
flows.push({
  id: 'sim-dendro-debug-setup',
  type: 'debug',
  z: SIM_TAB,
  name: 'Setup Result',
  active: true,
  tosidebar: true,
  complete: 'payload',
  targetType: 'msg',
  statusVal: '',
  statusType: 'auto',
  x: 730, y: 500,
  wires: [],
});

// ── Write patched flows ────────────────────────────────────────────────────
fs.writeFileSync(FLOWS_PATH, JSON.stringify(flows, null, 2));
console.log('Patched flows.json — added', SIM_IDS.length, 'nodes');
