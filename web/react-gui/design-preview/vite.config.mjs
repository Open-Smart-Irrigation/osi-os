import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { environment } from './fixtures.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const implemented = process.env.SWT_PREVIEW_MODE === 'implemented';

// Fail on source drift: a preview must never silently omit an intended change.
function replaceOnce(source, before, after, file) {
  if (source.split(before).length !== 2) throw new Error(`Preview anchor changed in ${file}: ${before}`);
  return source.replace(before, after);
}

function proposedCards() {
  return {
    name: 'swt-design-overlay', enforce: 'pre',
    transform(source, id) {
      if (implemented || !id.endsWith('.tsx')) return;
      const file = id.split('/').pop();
      if (!['KiwiSensorCard.tsx', 'DraginoTempCard.tsx', 'Sdi12SoilCard.tsx', 'IrrigationZoneCard.tsx'].includes(file)) return;
      const edit = (before, after) => { source = replaceOnce(source, before, after, file); };
      source = 'import { PreviewBadge, previewFormat, previewFresh } from "/design-preview/PreviewBadge.tsx";\n' + source;
      if (file === 'KiwiSensorCard.tsx') {
        for (const [field, value] of [['swt_1', 'swt1'], ['swt_2', 'swt2']]) {
          edit(`{renderValue('${field}', formatSwtValue(${value}, swtUnit))}`,
            `<div className="preview-reading">{renderValue('${field}', previewFormat(${value}, swtUnit))}<PreviewBadge value={${value}} device={device} /></div>`);
        }
      }
      if (file === 'DraginoTempCard.tsx') {
        edit('<span className="text-lg font-bold tabular-nums text-[var(--text)]">{formatSwtValue(channel.value, swtUnit) ?? \'—\'}</span>',
          '<span className="preview-reading preview-reading-end"><span className="text-lg font-bold tabular-nums text-[var(--text)]">{previewFormat(channel.value, swtUnit) ?? \'—\'}</span><PreviewBadge value={channel.value} device={device} /></span>');
        edit('className={`flex items-center justify-between rounded-md', 'className={`flex flex-wrap gap-2 items-center justify-between rounded-md');
      }
      if (file === 'Sdi12SoilCard.tsx') {
        edit('<span key={kind}>', '<span key={kind} className="preview-reading">');
        edit("<span className=\"tabular-nums\">{value == null ? '—' : formatChannelValue(kind, value)}</span>",
          "<span className=\"tabular-nums\">{value == null ? '—' : formatChannelValue(kind, value)}</span>{kind === 'swt' && device.sdi12_probe_profile === 'TENSIOMARK' && <PreviewBadge value={value} device={device} />}");
      }
      if (file === 'IrrigationZoneCard.tsx') {
        edit('const soilNow = summarizeZoneSoil(devices, Date.now(), triggerChannel);',
          'const soilSummary = summarizeZoneSoil(devices.filter(d => d.latest_data.chameleon_i2c_missing !== 1 && d.latest_data.chameleon_timeout !== 1), Date.now(), triggerChannel);\n  const soilNow = { ...soilSummary, stale: soilSummary.stale || !previewFresh(soilSummary.observedAt) };');
        edit('formatSwtValue(soilNow.value, swtUnit)', 'previewFormat(soilNow.value, swtUnit)');
        edit('<p className="mt-1 text-lg font-semibold text-[var(--text)]">\n                  {soilStatusLine === null ? soilValue ?? \'—\' : \'—\'}\n                </p>',
          '<div className="preview-reading mt-1"><span className="text-lg font-semibold text-[var(--text)]">{soilStatusLine === null ? soilValue ?? \'—\' : \'—\'}</span>{soilStatusLine === null && soilNow.quantity === \'tension\' && <PreviewBadge value={soilNow.value} observedAt={soilNow.observedAt} />}</div>');
      }
      return { code: source, map: null };
    },
  };
}

export default defineConfig({
  root, base: '/gui/',
  define: { __SWT_PREVIEW_MODE__: JSON.stringify(implemented ? 'implemented' : 'proposed') },
  server: { host: '127.0.0.1', port: 4178, strictPort: true },
  // There is deliberately no Node-RED proxy in the fixture server.
  plugins: [proposedCards(), react(), {
    name: 'swt-fixture-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/') && !req.url?.startsWith('/auth/')) return next();
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.statusCode = 405;
          return res.end(JSON.stringify({ message: 'This design preview cannot change gateway data.' }));
        }
        if (req.url === '/api/irrigation-zones/12/environment-summary') return res.end(JSON.stringify(environment));
        if (req.url === '/api/system/settings') return res.end(JSON.stringify({
          dataModuleEnabled: false, networkModuleEnabled: false,
          gatewayHubModuleEnabled: false, journalModuleEnabled: false,
        }));
        // History drawers may open, but the preview has no fabricated history.
        if (/^\/api\/devices\/[0-9A-F]{16}\/sensor-history(?:\?|$)/.test(req.url)) return res.end('[]');
        res.statusCode = 404;
        res.end(JSON.stringify({ message: `No preview fixture for ${req.url}` }));
      });
    },
  }],
});
