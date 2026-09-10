'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createRadioStore}=require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper');
const dbHelper=require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper');
const installation='00000000-0000-4000-8000-000000000001';
const gateway='0011223344556677';
for(const suffix of ['-wal','-shm','-journal']) test('orphaned '+suffix+' refuses first initialization without opening or marking',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'osi-radio-orphan-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const dbPath=path.join(dir,'radio.db');fs.writeFileSync(dbPath+suffix,'orphan');
 const farmingDb={get:async sql=>sql.includes('installation_identity')?{installation_uuid:installation,recovery_state:'ACTIVE'}:undefined,transaction:()=>assert.fail('must not create marker')};
 const store=createRadioStore({dbPath,installationUuid:installation,gatewayEui:gateway,farmingDb,dbFactory:()=>assert.fail('must not open SQLite')});
 await assert.rejects(store.status,/orphaned radio sidecars/);assert.equal(fs.existsSync(dbPath),false);
});
test('independent facade cannot create second farming database queue',()=>{
 assert.throws(()=>dbHelper.open('/data/db/farming.db'),/not approved/);
});
