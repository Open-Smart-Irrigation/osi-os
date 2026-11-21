'use strict';
// Git links different deflate implementations on Fedora and GitHub's Ubuntu
// image. Canonicalize its binary payloads to RFC 1950 stored DEFLATE blocks;
// compression choices must not decide the patch==renderer gate.
const assert=require('node:assert/strict');
const {inflateSync}=require('node:zlib');
const ALPHABET='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
function decode(lines){
 return Buffer.concat(lines.map(line=>{
  const first=line.charCodeAt(0),length=first<=90?first-64:first-70;
  assert.ok(length>=1&&length<=52,'invalid Git binary line length');
  assert.equal(line.length,1+Math.ceil(length/4)*5,'invalid Git binary line');
  const data=Buffer.alloc(Math.ceil(length/4)*4);
  for(let pos=1;pos<line.length;pos+=5){let value=0;for(let i=0;i<5;i++){const digit=ALPHABET.indexOf(line[pos+i]);assert.ok(digit>=0);value=value*85+digit;}assert.ok(value<=0xffffffff);data.writeUInt32BE(value,(pos-1)/5*4);}
  return data.subarray(0,length);
 }));
}
function encode(data){
 const lines=[];
 for(let offset=0;offset<data.length;offset+=52){
  const part=data.subarray(offset,offset+52),padded=Buffer.alloc(Math.ceil(part.length/4)*4);part.copy(padded);
  let line=String.fromCharCode(part.length+(part.length<=26?64:70));
  for(let pos=0;pos<padded.length;pos+=4){let value=padded.readUInt32BE(pos),group='';for(let i=0;i<5;i++){group=ALPHABET[value%85]+group;value=Math.floor(value/85);}line+=group;}
  lines.push(line);
 }
 return lines;
}
function storedZlib(data){
 const blocks=[Buffer.from([0x78,0x01])];
 for(let offset=0;offset<data.length||offset===0;offset+=65535){
  const part=data.subarray(offset,offset+65535),header=Buffer.alloc(5);header[0]=offset+part.length===data.length?1:0;header.writeUInt16LE(part.length,1);header.writeUInt16LE(part.length^0xffff,3);blocks.push(header,part);
 }
 let a=1,b=0;for(const value of data){a=(a+value)%65521;b=(b+a)%65521;}
 const adler=Buffer.alloc(4);adler.writeUInt32BE(((b<<16)|a)>>>0);blocks.push(adler);
 return Buffer.concat(blocks);
}
function canonicalBinaryPatch(patch){
 const lines=patch.trimEnd().split('\n'),result=[];
 for(let i=0;i<lines.length;i++){
  const line=lines[i];result.push(line);
  const header=/^(?:delta|literal) (\d+)$/.exec(line);if(!header)continue;
  const payload=[];while(i+1<lines.length&&lines[i+1]!=='')payload.push(lines[++i]);
  const raw=inflateSync(decode(payload));assert.equal(raw.length,Number(header[1]),'Git payload size');
  result.push(...encode(storedZlib(raw)));
 }
 // A blank separator terminates the final Git binary hunk.
 return result.join('\n').trimEnd()+'\n\n';
}
module.exports={canonicalBinaryPatch,decode,encode,storedZlib};
