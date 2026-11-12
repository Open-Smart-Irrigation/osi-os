# Dendrometer weather transport repair

Restore default Open-Meteo and configured OpenAgri weather requests in `dendro-compute-fn` by moving its HTTP transport into the existing `osi-dendro-analytics` module. The node already obtains that module through `osiLib.require('dendro-analytics')`.

This implements the CTO's W1 ruling and issue #629. Base: `fix/function-sandbox-bindings` at `9c0495a71`; #631 is still open, so this is a separate stacked PR. No changes to #631 beyond its ruled description and risk corrections belong here.

## Risk and review

Risk classes: `flows` and `field-history`. This changes a non-trivial function node and restores weather inputs written into daily analytics. It does not change actuator commands, schema, auth, provider selection or rain/VPD calculations. Independent review and any required council/lead sign-off remain with the steward before merge. The campaign prohibits implementation subagents; this file claims no independent approval.

## Failing evidence

`node --test --test-name-pattern='sandbox transport' scripts/test-dendro-rolling-7d-rain.js` fails four tests, default HTTPS Open-Meteo and configured HTTP OpenAgri in each profile, with `require is not defined`. The tested node is byte-identical to `origin/main` at `1bdd49d5`. Both existing weather harnesses now use a VM without `require` and stub the HTTP/HTTPS request functions; they open only an in-memory database.

## Implementation

In both maintained `flows.json` profiles, replace the complete `requestJson` function below with `const requestJson = DA.requestJson;`. Append that function, unchanged, to `osi-dendro-analytics/index.js` before its exports and add `requestJson` to the exports object. Mirror the module file byte-for-byte to bcm2709. This uses an existing registered module and deployed filename, so it needs no registry, deployment-script or runtime dependency change.

```js
function requestJson(method,urlString,options){
  const opts=options||{};
  const headers=Object.assign({},opts.headers||{});
  const body=opts.body!=null?String(opts.body):null;
  return new Promise((res,rej)=>{
    const lib=urlString.startsWith('https:')?require('https'):require('http');
    const req=lib.request(urlString,{method,headers},r=>{
      let d='';
      r.on('data',c=>d+=c);
      r.on('end',()=>{
        const status=Number(r.statusCode||0);
        if(status<200||status>=300){
          return rej(new Error('HTTP '+status+(d?': '+String(d).slice(0,160):'')));
        }
        if(!d)return res(null);
        try{res(JSON.parse(d));}catch(e){rej(e);}
      });
    });
    req.on('error',rej);
    req.setTimeout(10000,()=>{req.destroy(new Error('timeout'));});
    if(body!=null)req.write(body);
    req.end();
  });
}

```

In the same node, replace its two `catch(_){}` blocks in order with:

```js
catch(error){node.warn('Dendro baseline VPD failed: '+String(error&&error.message?error.message:error));}
catch(error){node.warn('Dendro SD-VPD comparison failed: '+String(error&&error.message?error.message:error));}
```

Replace the error-cleanup `catch(e){}` with:

```js
catch(error){node.warn('Dendro error cleanup failed: '+String(error&&error.message?error.message:error));}
```

Make no other change to the node. Use a scratch Node editor that asserts both profiles roundtrip byte-identically and agree before mutation, asserts the exact replacements and absence of remaining empty catches, writes both profiles, then checks the roundtrip again. The extracted transport removes more code than the catch warnings add; the size gate must pass without an exception.

The silent-catch verifier requires its baseline to equal the live count even
when the count shrinks. Ratchet both maintained counts in
`scripts/fixtures/silent-catch-baseline.json` from 77 to 74, append the reason
to its existing provenance, and update the count assertion in
`scripts/verify-live-gateway-identity.js`. Preserve the prior provenance and
all gateway-identity checks. This is verifier metadata, not a gateway change.

Remove only the `dendro-compute-fn` entry from `scripts/flows-sandbox-exceptions.json` and remove its corresponding documented exception. Leave the other three reviewed exceptions intact. Update the documented exception count to three.

The existing `test-dendro-rolling-7d-rain.js` provider suite includes the new sandbox regression tests. Update `test-dendro-rain-policy.js` to stub the helper's actual builtin requests as well, retaining every policy assertion. Both files are already run in hosted checks; no workflow change is needed.

## Verification and delivery

Run one suite at a time:

```sh
node --test --test-name-pattern='sandbox transport' scripts/test-dendro-rolling-7d-rain.js
node --test scripts/test-dendro-rolling-7d-rain.js
node --test scripts/test-dendro-rain-policy.js
node --test scripts/verify-flows-sandbox.test.js
node scripts/verify-flows-sandbox.js
node --test scripts/test-dendro-contract.js
node scripts/capture-dendro-analytics-vectors.js --verify
node scripts/verify-flows-size-ratchet.js
node scripts/verify-no-new-silent-catch.js
node scripts/test-flows-wiring.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-helper-registration.js
node scripts/verify-module-file-deploy-coverage.js
node scripts/verify-profile-parity.js
node scripts/verify-doc-hygiene.js
node scripts/verify-test-inventory.js
node scripts/verify-sync-flow.js
```

Expect exit 0 for each, the four sandbox transport tests passing, no dendrometer sandbox exception printed, lower embedded JavaScript size, and `All parity checks passed.` from the full flow gate. Golden analytics outputs must remain unchanged. Run prose and diff checks before committing.

Commit the transport repair, tests, exception removal and this plan in one `fix:` commit. Open a separate stacked PR against `fix/function-sandbox-bindings`, naming #631 as its dependency. The operator gets weather rainfall in daily dendrometer analytics and weather VPD when no local humidity sensor supplies it. Keep both PRs open for the steward; do not merge or deploy.
