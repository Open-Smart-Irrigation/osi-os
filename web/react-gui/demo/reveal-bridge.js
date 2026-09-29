// Call once after creating your Reveal instance. The iframe stays mounted.
export function connectOsiDemo(deck, frame) {
  const channel = 'osi-wasag-demo-v1';
  const origin = new URL(frame.src, location.href).origin;
  if (origin !== location.origin) throw new Error('Serve the OSI demo and slides from the same origin');
  const update = () => frame.contentWindow?.postMessage({channel, type: 'active', value: deck.getCurrentSlide()?.contains(frame) === true}, origin);
  const focus = event => {
    if (event.origin === origin && event.source === frame.contentWindow && event.data?.channel === channel && event.data?.type === 'focus' && Object.keys(event.data).length === 2) {
      frame.blur(); const root = deck.getRevealElement(); root.tabIndex = -1; root.focus();
    }
  };
  deck.on('slidechanged', update); deck.on('ready', update); frame.addEventListener('load', update); window.addEventListener('message', focus); update();
  return () => {deck.off('slidechanged', update); deck.off('ready', update); frame.removeEventListener('load', update); window.removeEventListener('message', focus);};
}
