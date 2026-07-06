const assert = require('assert');
const test = require('node:test');

const {
  countSilentCatchesInFlow,
  evaluateProfileCounts,
} = require('./verify-no-new-silent-catch.js');

test('counts empty catch blocks only in function node source', () => {
  const flow = [
    { type: 'function', func: 'try { work(); } catch(_){}' },
    { type: 'function', func: 'try { workA(); } catch (e) { } try { workB(); } catch(err){ node.warn(err.message); }' },
    { type: 'debug', func: 'try { work(); } catch(e){}' },
    { type: 'function', func: 'try { work(); } catch (error) { node.warn(error.message); }' },
  ];

  assert.deepStrictEqual(countSilentCatchesInFlow(flow), {
    functionNodeCount: 3,
    silentCatchCount: 2,
  });
});

test('counts optional catch binding empty blocks', () => {
  const flow = [
    { type: 'function', func: 'try { work(); } catch {}' },
    { type: 'function', func: 'try { work(); } catch { node.warn("visible"); }' },
  ];

  assert.deepStrictEqual(countSilentCatchesInFlow(flow), {
    functionNodeCount: 2,
    silentCatchCount: 1,
  });
});

test('counts comment-only catch bodies as silent', () => {
  const flow = [
    { type: 'function', func: 'try { work(); } catch (e) { /* ignore */ }' },
    { type: 'function', func: 'try { work(); } catch (e) { // ignore\n }' },
  ];

  assert.deepStrictEqual(countSilentCatchesInFlow(flow), {
    functionNodeCount: 2,
    silentCatchCount: 2,
  });
});

test('counts bare-semicolon catch bodies as silent', () => {
  const flow = [{ type: 'function', func: 'try { work(); } catch (e) {;}' }];

  assert.deepStrictEqual(countSilentCatchesInFlow(flow), {
    functionNodeCount: 1,
    silentCatchCount: 1,
  });
});

test('counts destructured-binding empty catch bodies as silent', () => {
  const flow = [
    { type: 'function', func: 'try { work(); } catch ({message}) {}' },
    { type: 'function', func: 'try { work(); } catch ([a, b]) {}' },
  ];

  assert.deepStrictEqual(countSilentCatchesInFlow(flow), {
    functionNodeCount: 2,
    silentCatchCount: 2,
  });
});

test('counts empty promise-style .catch() handlers as silent', () => {
  const flow = [
    { type: 'function', func: 'doThing().catch(() => {});' },
    { type: 'function', func: 'doThing().catch(function(){});' },
    { type: 'function', func: 'doThing().catch(function (err) {\n});' },
    { type: 'function', func: 'doThing().catch((err) => { node.warn(err); });' },
  ];

  assert.deepStrictEqual(countSilentCatchesInFlow(flow), {
    functionNodeCount: 4,
    silentCatchCount: 3,
  });
});

test('scans initialize and finalize fields in addition to func', () => {
  const flow = [
    {
      type: 'function',
      func: 'node.send(msg);',
      initialize: 'try { setup(); } catch (e) {}',
      finalize: 'try { teardown(); } catch (e) { /* ignore */ }',
    },
  ];

  assert.deepStrictEqual(countSilentCatchesInFlow(flow), {
    functionNodeCount: 1,
    silentCatchCount: 2,
  });
});

test('fails on increased or stale-lower counts against the baseline', () => {
  const baseline = {
    profiles: {
      bcm2712: { silentCatchCount: 247 },
      bcm2709: { silentCatchCount: 247 },
    },
  };

  assert.deepStrictEqual(
    evaluateProfileCounts(
      {
        bcm2712: { silentCatchCount: 248 },
        bcm2709: { silentCatchCount: 247 },
      },
      baseline,
    ),
    [
      'bcm2712: live silent catch count 248 exceeds baseline 247',
    ],
  );

  assert.deepStrictEqual(
    evaluateProfileCounts(
      {
        bcm2712: { silentCatchCount: 246 },
        bcm2709: { silentCatchCount: 247 },
      },
      baseline,
    ),
    [
      'bcm2712: live silent catch count 246 is below baseline 247; update the baseline downward in this commit',
    ],
  );
});
