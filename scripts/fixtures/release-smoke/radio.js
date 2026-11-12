'use strict';
// A real gRPC boundary: the shipped osi-chirpstack-helper serializes requests.
const grpc = require('@grpc/grpc-js');
const { DeviceServiceService } = require('@chirpstack/chirpstack-api/api/device_grpc_pb');
const pb = require('@chirpstack/chirpstack-api/api/device_pb');
const { Empty } = require('google-protobuf/google/protobuf/empty_pb');
const { randomUUID } = require('node:crypto');
exports.start = async function (state) {
  const server = new grpc.Server();
  server.addService(DeviceServiceService, {
    enqueue(call, callback) {
      const item = call.request.getQueueItem();
      item.setId(randomUUID());
      const eui = item.getDevEui().toUpperCase();
      (state.cs.queue[eui] ||= []).push(item);
      state.cs.calls.push({ fn:'enqueue', eui, port:item.getFPort(), hex:Buffer.from(item.getData_asU8()).toString('hex'), id:item.getId(),expiresAt:item.getExpiresAt()?.toDate().toISOString()||null });
      const response = new pb.EnqueueDeviceQueueItemResponse(); response.setId(item.getId());
      // A case may model a slow network server; the default answers at once.
      if (state.cs.latencyMs) setTimeout(() => callback(null, response), state.cs.latencyMs);
      else callback(null,response);
    },
    getQueue(call,callback) {
      const response=new pb.GetDeviceQueueItemsResponse();response.setResultList(state.cs.queue[call.request.getDevEui().toUpperCase()]||[]);callback(null,response);
    },
    flushQueue(call,callback) {const eui=call.request.getDevEui().toUpperCase();state.cs.calls.push({fn:'flush',eui});state.cs.queue[eui]=[];callback(null,new Empty());},
    delete(call,callback) {state.cs.calls.push({fn:'delete',eui:call.request.getDevEui().toUpperCase()});callback(null,new Empty());}
  });
  const port=await new Promise((resolve,reject)=>server.bindAsync('127.0.0.1:0',grpc.ServerCredentials.createInsecure(),(e,p)=>e?reject(e):resolve(p)));
  return {url:'http://127.0.0.1:'+port,stop:()=>new Promise(r=>server.tryShutdown(r))};
};
