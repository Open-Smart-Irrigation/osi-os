import type {CSSProperties, TargetedPointerEvent} from 'preact';
import {useRef, useState} from 'preact/hooks';
import type {Direction} from '../input/mapping';
import {stickDirection} from '../input/mapping';
import type {RunFeedback} from '../core/replay';
import type {TileRef, ToolId, ViewModel} from '../core/types';

const TOOL_NAMES: Record<ToolId, string> = {
  hoe: 'Hoe', seedling: 'Seedling', can: 'Watering can', jerrycan: 'Jerrycan', basket: 'Basket',
};
export function clockLabel(hour: number): string {
  const minutes = Math.floor(hour * 60 + 1e-8);
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

/** Real time for `step`: none while a panel that blocks input (facilitator or About) or the sleep screen is up. */
export function frameDelta(realMs: number, panel: 'facilitator' | 'about' | undefined, sleeping: boolean): number {
  return panel !== undefined || sleeping ? 0 : realMs;
}

export function FarmHud({vm, pickedKg, used, about}: {
  vm: ViewModel; pickedKg: number; used: number; about(): void;
}) {
  const {hour, day, sunriseHour, sunsetHour, raining} = vm.sky;
  const daylight = Math.max(0, Math.min(1, (hour - sunriseHour) / (sunsetHour - sunriseHour)));
  return <header class="farm-hud">
    <div class="clock-board">
      <div class="clock-face">
        <b>Day {day} <span>/ 14</span></b>
        <time>{clockLabel(hour)}</time>
      </div>
      <div class="daylight" role="meter" aria-label="Daylight" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(daylight * 100)} style={{'--sun': daylight * 100 + '%', '--lift': -9 * Math.sin(Math.PI * daylight) + 'px'}}>
        <i /><span>{raining ? 'Rain' : vm.sky.season}</span>
      </div>
    </div>
    <div class="farm-totals" aria-label="Farm totals">
      <span><strong data-testid="picked">{pickedKg.toFixed(2)}</strong> kg picked</span>
      <span><strong data-testid="litres-used">{used.toFixed(1)}</strong> L used</span>
      <span><strong data-testid="tank-litres">{vm.water.tankLiters.toFixed(0)}</strong> L tank</span>
    </div>
    <button class="about-button" onClick={about} aria-label="About this screen">?</button>
    <span class="game-label">game</span>
  </header>;
}

function Stick({onDirection}: {onDirection(direction: Direction): void}) {
  const [handle, setHandle] = useState({x: 0, y: 0});
  const active = useRef<number>(undefined);
  function move(event: TargetedPointerEvent<HTMLDivElement>) {
    if (active.current !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    const scale = Math.min(1, 26 / Math.max(1, Math.hypot(x, y)));
    setHandle({x: x * scale, y: y * scale});
    onDirection(stickDirection(x, y));
  }
  return <div class="stick" aria-label="Movement stick"
    onPointerDown={event => {
      if (active.current !== undefined) return;
      active.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      move(event);
    }}
    onPointerMove={move}
    onLostPointerCapture={event => {
      if (event.pointerId !== active.current) return;
      active.current = undefined;
      setHandle({x: 0, y: 0});
      onDirection({dx: 0, dy: 0});
    }}>
    <span style={{transform: 'translate(' + handle.x + 'px,' + handle.y + 'px)'}} />
  </div>;
}

export function ToolBelt({vm, icons, selected, select}: {
  vm: ViewModel; icons: Record<string, CSSProperties>; selected: ToolId; select(tool: ToolId): void;
}) {
  return <div class="tool-belt" aria-label="Tools">
    {vm.hud.tools.map((tool, i) => <button key={tool} title={TOOL_NAMES[tool] + ' (' + (i + 1) + ')'}
      aria-label={TOOL_NAMES[tool]} aria-pressed={tool === selected} onClick={() => select(tool)}>
      <span aria-hidden="true" class="tool-icon" style={icons[tool]} />
      <small>{tool === 'can' ? vm.hud.canLiters + ' L' : tool === 'jerrycan' ? vm.hud.jerrycanLiters + ' L' : i + 1}</small>
    </button>)}
    <div class="energy"><label htmlFor="energy">Energy {vm.player.energy}</label>
      <meter id="energy" min={0} max={vm.hud.maxEnergy} value={vm.player.energy} />
    </div>
  </div>;
}

export function GameControls({vm, feedback, hint, sites, target, openPhone, direction, useSelected}: {
  vm: ViewModel; feedback: RunFeedback; hint?: string;
  sites: Readonly<Record<'houseDoor' | 'tank' | 'pump' | 'firstBed', TileRef>>;
  target(tile: TileRef, action: ToolId | 'interact' | 'sleep'): void;
  openPhone(): void; direction(direction: Direction): void; useSelected(): void;
}) {
  return <>
    <Stick onDirection={direction} />
    <div class="action-area">
      {(hint || feedback.notice || vm.hud.moistureLens) &&
        <aside class="field-note" aria-label="Farm notes">
          {hint && <p><b>game</b> {hint}</p>}
          {feedback.notice && <p role="status">{!hint && <b>game</b>}{feedback.notice}</p>}
          {vm.hud.moistureLens && <p>Moisture lens · game · blue means wetter soil</p>}
        </aside>}
      <div class="farm-actions" aria-label="Farm actions">
        <button class="touch-action" onClick={useSelected}>Use tool</button>
        <button onClick={() => target(sites.firstBed, 'interact')}>Feel soil</button>
        <button onClick={() => target(sites.tank, 'can')}>Fill can</button>
        <button onClick={() => target(sites.pump, 'interact')}>Pump</button>
        {vm.tier < 3 && <button onClick={() => target(sites.tank, 'interact')}>
          {feedback.manualTapOpen ? 'Close tap' : 'Open tap'}
        </button>}
        {vm.hud.canUsePhone && <button onClick={openPhone}>Raise phone</button>}
        <button disabled={!vm.hud.canSleep} title="Available after 18:00"
          onClick={() => target(sites.houseDoor, 'sleep')}>Sleep</button>
      </div>
    </div>
    <p class="keys-hint">Move WASD or arrows · E interact · Space use tool · Click a tile to approach it</p>
  </>;
}

export function PhoneControls({lower}: {lower(): void}) {
  return <aside class="phone-controls" aria-label="Raised phone">
    <button onClick={lower}>Lower phone</button>
  </aside>;
}
