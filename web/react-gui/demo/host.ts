import {CHANNEL} from './protocol';
const frame = document.querySelector<HTMLIFrameElement>('#app')!;
const phone = document.querySelector<HTMLElement>('.phone')!;
const space = document.querySelector<HTMLElement>('.phone-space')!;
const pause = document.querySelector<HTMLButtonElement>('#pause')!;
const enlarge = document.querySelector<HTMLButtonElement>('#enlarge')!;
const speed = document.querySelector<HTMLSelectElement>('#speed')!;
const focusButton = document.querySelector<HTMLButtonElement>('#focus')!;
let paused = false, slideActive = true, resetGeneration = 0;
function send(type: 'speed' | 'active', value: number | boolean) {frame.contentWindow?.postMessage({channel: CHANNEL, type, value}, location.origin);}
function activity() {send('active', slideActive && !paused && !document.hidden);}
function size() {
  const enlarged = document.body.classList.contains('enlarged');
  const sideControls = enlarged && innerWidth >= 700;
  const width = sideControls ? innerWidth - 300 : enlarged || innerWidth < 700 ? innerWidth - 24 : innerWidth * .43;
  const scale = enlarged ? Math.max(.2, Math.min(1.25, width / 402)) : Math.max(.2, Math.min((innerHeight - 180) / 856, width / 402));
  const phoneHeight = enlarged ? Math.min(856, (innerHeight - (sideControls ? 32 : 210)) / scale) : 856;
  phone.style.height = `${phoneHeight}px`;
  frame.style.height = `${phoneHeight - 12}px`;
  phone.style.transform = `scale(${scale})`;
  space.style.width = `${402 * scale}px`; space.style.height = `${phoneHeight * scale}px`;
}
enlarge.onclick = () => {document.body.classList.toggle('enlarged'); enlarge.textContent = document.body.classList.contains('enlarged') ? 'Return to slide' : 'Enlarge demo'; size();};
function pauseFeedback() {
  pause.textContent = paused ? 'Resume' : 'Pause';
  pause.setAttribute('aria-pressed', String(paused));
  document.querySelector<HTMLElement>('#clock-status')!.hidden = !paused;
}
pause.onclick = () => {paused = !paused; pauseFeedback(); activity();};
function showNotice(message: string) {
  document.querySelector('#host-notice')!.textContent = message;
  document.querySelector<HTMLElement>('#dismiss-notice')!.hidden = !message;
}
document.querySelector<HTMLButtonElement>('#dismiss-notice')!.onclick = () => showNotice('');
speed.onchange = () => send('speed', Number(speed.value));
focusButton.onclick = () => {focusButton.focus(); if (parent !== window) parent.postMessage({channel: CHANNEL, type: 'focus'}, location.origin);};
document.querySelector<HTMLButtonElement>('#reset')!.onclick = () => {
  paused = false; pauseFeedback(); speed.value = '1'; showNotice('');
  frame.src = `./app.html?session=${++resetGeneration}#/dashboard`;
};
window.addEventListener('message', event => {
  if (event.origin !== location.origin || !event.data || event.data.channel !== CHANNEL) return;
  const data = event.data;
  if (event.source === frame.contentWindow) {
    if (Object.keys(data).length === 2 && data.type === 'ready') {send('speed', Number(speed.value)); activity();}
    if (Object.keys(data).length === 2 && data.type === 'focus') focusButton.click();
    if (Object.keys(data).length === 3 && data.type === 'notice' && typeof data.message === 'string' && data.message.length <= 600) showNotice(data.message);
  } else if (parent !== window && event.source === parent && Object.keys(data).length === 3 && data.type === 'active' && typeof data.value === 'boolean') {
    slideActive = data.value; activity();
  }
});
document.addEventListener('visibilitychange', activity);
window.addEventListener('resize', size);
new IntersectionObserver(entries => {if (parent === window) return; slideActive = entries[0].isIntersecting; activity();}).observe(frame);
size();
