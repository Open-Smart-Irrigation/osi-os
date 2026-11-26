import type {i18n as I18n} from 'i18next';

const PLACEHOLDER = 'input[id="gateway-timezone"], input[id^="zone-config-timezone-"]';
const HEADING = 'data-farm-sim-literal';

export function installPhoneDomShim(root: HTMLElement, i18n: I18n): void {
  function update() {
    for (const input of root.querySelectorAll<HTMLInputElement>(PLACEHOLDER)) {
      const label = i18n.t('advancedSchedule.timezoneExample', {ns: 'devices'});
      if (input.placeholder !== label) input.placeholder = label;
    }
    const heading = i18n.t('farmSim.flowMeterHeading', {ns: 'common'});
    for (const p of root.querySelectorAll('p')) {
      if (p.textContent === 'Flow Meter') p.setAttribute(HEADING, 'flowMeterHeading');
      if (p.getAttribute(HEADING) === 'flowMeterHeading' && p.textContent !== heading) p.textContent = heading;
    }
  }

  new MutationObserver(update).observe(root, {childList: true, characterData: true, subtree: true});
  i18n.on('languageChanged', update);
  update();
}
