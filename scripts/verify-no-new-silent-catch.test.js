const assert = require('assert');
const test = require('node:test');

const {
  countSilentCatchesInFlow,
  evaluateProfileCounts,
} = require('./verify-no-new-silent-catch.js');

test('counts empty catch blocks only in function node source', () => {
  const flow = [
    { type: 'function', func: 'try { work(); } catch(_){}' },
    { type: 'function', func: 'try { work(); } catch (e) { } catch(err){ node.warn(err.message); }' },
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
