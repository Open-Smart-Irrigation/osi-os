'use strict';
const hash = 'a'.repeat(64), valid = JSON.stringify({ '0001__a.sql': hash });
const vectors = [
  ['valid', valid, true], ['sparse', JSON.stringify({ '0001__a.sql': hash, '0003__c.sql': hash }), true],
  ['zero', JSON.stringify({ '0000__zero.sql': hash }), true], ['escaped', '{"0001__\\u0061.sql":"'+hash+'"}', true],
  ...['', '{}', 'null', '[]', '42', valid+'x', valid.slice(0,-1)+',}', '\ufeff'+valid,
    '{"0001__a.sql":"'+hash+'","0001__a.sql":"'+hash+'"}',
    '{"0001__a.sql":"'+hash+'","0001__\\u0061.sql":"'+hash+'"}',
    JSON.stringify({'0001__a.sql':hash,'0001__b.sql':hash}),
    JSON.stringify({'0001__a.sql':[hash]}), JSON.stringify({'0001__a.sql':{}}),
    '{"0001__\\q.sql":"'+hash+'"}', Buffer.from([255])].map((raw,i)=>['structure-'+i,raw,false]),
  ...['../a.sql','/a.sql','0001__a b.sql','0001__a\n.sql','0001__a*.sql','0001__a%2f.sql','0001__A.sql','__proto__','0001__a.sql\n','0001__a\\b.sql'].map((name,i)=>['name-'+i,JSON.stringify({[name]:hash}),false]),
  ...[hash.toUpperCase(),hash.slice(1),hash+'a',hash.slice(1)+'g',hash+'\n',1,true,null].map((v,i)=>['hash-'+i,JSON.stringify({'0001__a.sql':v}),false]),
].map(([name,raw,valid])=>({name,raw:Buffer.isBuffer(raw)?raw:Buffer.from(raw),valid}));
module.exports = { vectors };
