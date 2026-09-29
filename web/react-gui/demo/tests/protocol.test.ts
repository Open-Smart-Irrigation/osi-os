import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CHANNEL, isHostCommand} from '../protocol';
test('host command protocol accepts only exact boolean activity and enumerated speed payloads',()=>{
  assert.ok(isHostCommand({channel:CHANNEL,type:'active',value:false}));
  assert.ok(isHostCommand({channel:CHANNEL,type:'speed',value:60}));
  for(const value of [null,{}, {channel:CHANNEL,type:'active',value:'true'}, {channel:CHANNEL,type:'speed',value:-1}, {channel:CHANNEL,type:'speed',value:Infinity}, {channel:CHANNEL,type:'reset',value:true}, {channel:CHANNEL,type:'active',value:true,extra:1}]) assert.equal(isHostCommand(value),false);
});
