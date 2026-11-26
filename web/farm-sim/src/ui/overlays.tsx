import {useState} from 'preact/hooks';
import type {RunFeedback} from '../core/replay';
import type {SliceReport} from '../core/report';
import type {ReplayHeader, Scenario, Tier, WorldDayView} from '../core/types';

export const TIER_NAMES = ['Manual farm', 'Soil readings', 'Water demand', 'Phone valve', 'Automatic trigger'] as const;

export function About({tier, area, close}: {tier: Tier; area: number; close(): void}) {
  return <section class="game-panel floating" aria-label="About this screen">
    <header><h2>About this screen <small>game</small></h2><button onClick={close}>Close</button></header>
    <p>Plants, rainfall, tank water and the figures on the farm screen come from the game.</p>
    {tier === 0 && <p>This farm uses a can and a manual tap.</p>}
    {tier >= 1 && <p>The phone uses the OSI app to group and chart soil readings at 20 and 40 cm. The simulated probe samples the soil in bed A.</p>}
    {tier >= 2 && <>
      <p>OSI computed today's crop water use from the game's weather forecast with its FAO-56 code. On a real gateway the forecast comes from a weather provider.</p>
      <p>Current conditions, hourly temperature, rain chances and the forecast cards' highs and lows are illustrative. Forecast rain and wind come from the game forecast.</p>
      <p>The phone meter counts water on the date of the reporting sample. The game report counts it on the date it reaches the bed.</p>
    </>}
    {tier >= 3 && <>
      <p>The phone uses the OSI simulator to run timed opens, early closes and plans.</p>
      <p>If the tank runs dry, the game's dry-run switch closes the valve. The phone then shows the run as cancelled.</p>
    </>}
    {tier === 4 && <p>The OSI simulator checks the last hour of soil readings at 06:00. The threshold and watering duration are set on the phone. A trigger on one sensor reads only that depth, so a run that is too short can keep that depth wet while the soil below it dries.</p>}
    {tier >= 2 && <Calculator area={area} />}
  </section>;
}

function Calculator({area}: {area: number}) {
  const [et0, setEt0] = useState('');
  const [kc, setKc] = useState('');
  const liters = et0 && kc && Number(et0) >= 0 && Number(kc) >= 0 ? Number(et0) * Number(kc) * area : null;
  return <fieldset class="calculator">
    <legend>Litres for bed A · game</legend>
    <label>ET0 (mm) <input type="number" min="0" step="any" value={et0} onInput={e => setEt0(e.currentTarget.value)} /></label>
    <label>Kc <input type="number" min="0" step="any" value={kc} onInput={e => setKc(e.currentTarget.value)} /></label>
    <output>{liters === null ? 'Enter ET0 and Kc from the Water tab.' : liters.toFixed(1) + ' L across ' + area + ' m²'}</output>
  </fieldset>;
}

function WaterRow({day}: {day: Omit<WorldDayView, 'date' | 'at' | 'meanKs' | 'stressDay'> & {stressDays: number | null}}) {
  return <>
    <td>{day.rainMm}</td>
    <td>{day.irrigationLiters.can} / {day.irrigationLiters.tap} / {day.irrigationLiters.valve}</td>
    <td>{day.pumpStrokes} / {day.carryTrips}</td>
    <td>{day.runoffLiters} / {day.percolationLiters} / {day.applicationLossLiters}</td>
    <td>{day.waterEnergy} / {day.waterMinutes}</td>
    <td>{day.soilWaterMm.start} / {day.soilWaterMm.end}</td><td>{day.stressDays ?? '–'}</td>
    <td>{day.pickedKg} / {day.lostKg}</td>
    <td>{day.waterProductivityKgPerM3 ?? '–'}</td><td>{day.cutoffs.length}</td>
  </>;
}

/** Core builds the T4 comparison into the report. */
export function Report({report, restart, exportLog}: {report: SliceReport; restart(): void; exportLog(): void}) {
  const {comparison} = report;
  return <section class="game-panel floating report" aria-label="Slice report">
    <header><h2>Farm report <small>game</small></h2></header>
    <p><b>{report.total.pickedKg} kg</b> picked · <b>{report.total.stressDays}</b> bed A stress days</p>
    {comparison && <p>{comparison}</p>}
    <div class="report-table" tabIndex={0}>
      <table>
        <thead><tr><th>Farm date</th><th>Rain (mm)</th><th>Can / tap / valve (L)</th>
          <th>Pump strokes / shared-well trips</th>
          <th>Runoff / deep / drip loss (L)</th><th>Water work (energy / min)</th>
          <th>Bed A root zone, start / end (mm)</th><th>Bed A stress days</th><th>Picked / lost (kg)</th><th>kg/m³</th><th>Cutoffs</th></tr></thead>
        <tbody>{report.days.map((day, i) => <tr key={day.date}>
          <th>{day.date}{report.days.length === 15 && i === 14 ? ' (final morning)' : ''}</th>
          <WaterRow day={{...day, stressDays: report.days.length === 15 && i === 14 ? null : Number(day.stressDay)}} />
        </tr>)}</tbody>
        <tfoot><tr><th>Total</th><WaterRow day={report.total} /></tr></tfoot>
      </table>
    </div>
    {report.total.cutoffs.length > 0 && <ul>{report.total.cutoffs.map(cutoff =>
      <li key={cutoff.at}>{cutoff.liters.delivered} L delivered · {cutoff.liters.estimated} L estimated at cutoff</li>)}</ul>}
    <div class="panel-actions"><button onClick={exportLog}>Export log</button><button onClick={restart}>Start again</button></div>
  </section>;
}

export function Bedtime({card, close}: {card: NonNullable<RunFeedback['bedtime']>; close(): void}) {
  return <section class="game-panel bedtime" aria-label="Bedtime card">
    <h2>Bedtime <small>game</small></h2>
    <dl><div><dt>Litres applied</dt><dd>{card.appliedLiters}</dd></div>
      <div><dt>Kilograms picked</dt><dd>{card.pickedKg}</dd></div>
      <div><dt>Energy left</dt><dd>{card.energyLeft}</dd></div></dl>
    <button autoFocus onClick={close}>Wake at 05:50</button>
  </section>;
}

export function Facilitator({header, scenarios, close, start, exportLog, exportSave, load, problem}: {
  header: ReplayHeader; scenarios: readonly Scenario[]; close(): void;
  start(settings: Pick<ReplayHeader, 'scenario' | 'tier' | 'pace' | 'hints' | 'moistureLens' | 'pauseWhilePhoneOpen'>): void;
  exportLog(): void; exportSave(): void; load(file: File): void; problem?: string;
}) {
  const [draft, setDraft] = useState(header);
  const current = scenarios.find(scenario => scenario.id === draft.scenario)!;
  return <section class="game-panel floating facilitator" aria-label="Facilitator">
    <header><h2>Facilitator <small>game</small></h2><button onClick={close}>Close</button></header>
    <label>Scenario <select value={draft.scenario} onChange={event => {
      const next = scenarios.find(scenario => scenario.id === event.currentTarget.value)!;
      setDraft({...draft, scenario: next.id, tier: next.tiers.includes(draft.tier) ? draft.tier : next.tiers[0]});
    }}>{scenarios.map(scenario => <option key={scenario.id} value={scenario.id}>{scenario.id}</option>)}</select></label>
    <label>Tier <select value={draft.tier} onChange={event => setDraft({...draft, tier: Number(event.currentTarget.value) as Tier})}>
      {current.tiers.map(tier => <option key={tier} value={tier}>T{tier} · {TIER_NAMES[tier]}</option>)}
    </select></label>
    <label>Pace <select value={draft.pace} onChange={event => setDraft({...draft, pace: Number(event.currentTarget.value)})}>
      <option value={75}>75 · 12 min</option><option value={150}>150 · 6 min</option><option value={300}>300 · 3 min</option>
    </select></label>
    <label><input type="checkbox" checked={draft.pauseWhilePhoneOpen}
      onChange={event => setDraft({...draft, pauseWhilePhoneOpen: event.currentTarget.checked})} /> Pause while phone is open</label>
    <label><input type="checkbox" checked={draft.moistureLens}
      onChange={event => setDraft({...draft, moistureLens: event.currentTarget.checked})} /> Moisture lens</label>
    <label><input type="checkbox" checked={draft.hints}
      onChange={event => setDraft({...draft, hints: event.currentTarget.checked})} /> Hints</label>
    <div class="panel-actions">
      <button onClick={() => start(draft)}>Start new run</button>
      <button onClick={exportLog}>Export log</button><button onClick={exportSave}>Save replay</button>
    </div>
    <label>Load replay <input type="file" accept=".json,application/json" onChange={event => {
      const file = event.currentTarget.files?.[0];
      if (file) load(file);
      event.currentTarget.value = '';
    }} /></label>
    {problem && <p role="alert">{problem}</p>}
  </section>;
}
