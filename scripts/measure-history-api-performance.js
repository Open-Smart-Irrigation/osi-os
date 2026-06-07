#!/usr/bin/env node

const baseUrl = String(process.env.OSI_HISTORY_BASE_URL || '').replace(/\/+$/, '');
const token = String(process.env.OSI_HISTORY_TOKEN || '');
const zoneId = String(process.env.OSI_HISTORY_ZONE_ID || '');
const explicitCardId = String(process.env.OSI_HISTORY_CARD_ID || '');
const runs = Number.parseInt(String(process.env.OSI_HISTORY_RUNS || '7'), 10);
const warmups = Number.parseInt(String(process.env.OSI_HISTORY_WARMUPS || '2'), 10);

function usage() {
  console.error('Usage: OSI_HISTORY_BASE_URL=http://kaba100.local OSI_HISTORY_TOKEN=<jwt> OSI_HISTORY_ZONE_ID=<id> node scripts/measure-history-api-performance.js');
  console.error('Optional: OSI_HISTORY_CARD_ID=<card-id> OSI_HISTORY_RUNS=7 OSI_HISTORY_WARMUPS=2');
}

if (!baseUrl || !token || !zoneId || !Number.isFinite(runs) || runs < 1 || !Number.isFinite(warmups) || warmups < 0) {
  usage();
  process.exit(2);
}

function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(values) {
  if (!values.length) {
    return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    count: values.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1]
  };
}

async function timedFetch(pathname) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  });
  const bodyText = await response.text();
  const durationMs = Date.now() - startedAt;
  let body = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch (_) {
    body = bodyText;
  }
  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`${response.status} ${response.statusText} for ${pathname}: ${detail}`);
  }
  return { durationMs, body };
}

async function measure(label, pathname) {
  for (let i = 0; i < warmups; i += 1) {
    await timedFetch(pathname);
  }
  const timings = [];
  for (let i = 0; i < runs; i += 1) {
    const result = await timedFetch(pathname);
    timings.push(result.durationMs);
  }
  const summary = summarize(timings);
  console.log(JSON.stringify({ label, path: pathname, timingsMs: timings, summary }, null, 2));
  return summary;
}

function pickFirstCardId(cardsBody) {
  const cards = Array.isArray(cardsBody && cardsBody.cards) ? cardsBody.cards : Array.isArray(cardsBody) ? cardsBody : [];
  const preferred = cards.find((card) => card && card.cardType === 'soil') || cards.find((card) => card && (card.cardId || card.id));
  return preferred && (preferred.cardId || preferred.id) ? String(preferred.cardId || preferred.id) : '';
}

async function main() {
  const cardsPath = `/api/history/zones/${encodeURIComponent(zoneId)}/cards`;
  const discovery = await timedFetch(cardsPath);
  const cardId = explicitCardId || pickFirstCardId(discovery.body);

  await measure('zone-cards', cardsPath);

  if (!cardId) {
    console.error('No card ID discovered; set OSI_HISTORY_CARD_ID to measure card data.');
    return;
  }

  for (const range of ['24h', '7d', '30d']) {
    const dataPath = `/api/history/zones/${encodeURIComponent(zoneId)}/cards/${encodeURIComponent(cardId)}/data?range=${encodeURIComponent(range)}`;
    await measure(`card-data-${range}`, dataPath);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
