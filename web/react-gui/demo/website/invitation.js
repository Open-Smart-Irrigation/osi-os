(() => {
  const globalKey = '__osiSimulatorInvitationV1';
  if (window[globalKey]) return;
  window[globalKey] = true;

  const currentScript = document.currentScript;
  if (!currentScript?.src) return;
  const assetBase = new URL('.', currentScript.src);
  const simulatorUrl = new URL('/simulator/', window.location.origin).href;
  const storageKey = 'org.opensmartirrigation.simulator-invitation.dismissed.v1';
  let dismissedInMemory = false;

  function wasDismissed() {
    try {
      return window.sessionStorage.getItem(storageKey) === '1';
    } catch {
      return dismissedInMemory;
    }
  }

  function rememberDismissal() {
    dismissedInMemory = true;
    try {
      window.sessionStorage.setItem(storageKey, '1');
    } catch {
      // The page-local flag still prevents the invitation reopening in this document.
    }
  }

  async function install() {
    if (wasDismissed() || document.getElementById('osi-simulator-invitation')) return;

    let response;
    try {
      response = await fetch(new URL('invitation.html', assetBase), {credentials: 'same-origin'});
    } catch {
      return;
    }
    if (!response.ok) return;

    const markup = await response.text();
    const template = document.createElement('template');
    template.innerHTML = markup;
    const badge = template.content.querySelector('#osi-simulator-invitation');
    if (!(badge instanceof HTMLElement) || document.getElementById(badge.id)) return;

    const entry = badge.querySelector('[data-simulator-link]');
    const image = badge.querySelector('img');
    if (!(entry instanceof HTMLAnchorElement) || !(image instanceof HTMLImageElement)) return;
    entry.href = simulatorUrl;
    image.src = new URL('osi-os-preview.png', assetBase).href;

    document.body.append(template.content);
    const installedBadge = document.getElementById('osi-simulator-invitation');
    const close = installedBadge?.querySelector('.osi-simulator-invitation__close');
    if (!(installedBadge instanceof HTMLElement) || !(close instanceof HTMLButtonElement)) return;
    let lastOutsideFocus = document.activeElement instanceof HTMLElement && !installedBadge.contains(document.activeElement)
      ? document.activeElement
      : null;
    let pendingPositionFrame = null;
    let headerObserver = null;

    function onFocusIn(event) {
      const target = event.target;
      if (target instanceof HTMLElement && !installedBadge.contains(target)) lastOutsideFocus = target;
    }

    function positionBadge() {
      const header = document.querySelector('#osiUHeader');
      const menuButton = document.querySelector('#osiUBurger');
      const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
      const buttonStyle = menuButton ? getComputedStyle(menuButton) : null;
      const buttonRect = menuButton?.getBoundingClientRect();
      const buttonVisible = buttonStyle?.display !== 'none' && Boolean(buttonRect?.width && buttonRect.height);
      const anchorBottom = buttonVisible && buttonRect ? buttonRect.bottom : headerBottom;
      const badgeHeight = installedBadge.getBoundingClientRect().height;
      const top = Math.max(8, Math.min(Math.max(headerBottom, anchorBottom) + 8, window.innerHeight - badgeHeight - 8));
      installedBadge.style.setProperty('--osi-invitation-top', `${top}px`);
    }

    function schedulePositionBadge() {
      if (installedBadge.hidden || pendingPositionFrame !== null) return;
      pendingPositionFrame = window.requestAnimationFrame(() => {
        pendingPositionFrame = null;
        if (!installedBadge.hidden) positionBadge();
      });
    }

    function onPositioningEvent() {
      schedulePositionBadge();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape' && !installedBadge.hidden) dismiss();
    }

    function dismiss() {
      if (installedBadge.hidden) return;
      rememberDismissal();
      if (document.activeElement instanceof HTMLElement && installedBadge.contains(document.activeElement) && lastOutsideFocus?.isConnected) {
        lastOutsideFocus.focus({preventScroll: true});
      }
      installedBadge.hidden = true;
      if (pendingPositionFrame !== null) {
        window.cancelAnimationFrame(pendingPositionFrame);
        pendingPositionFrame = null;
      }
      headerObserver?.disconnect();
      headerObserver = null;
      window.removeEventListener('resize', onPositioningEvent);
      window.removeEventListener('orientationchange', onPositioningEvent);
      window.removeEventListener('scroll', onPositioningEvent);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      entry.removeEventListener('click', dismiss);
      close.removeEventListener('click', dismiss);
    }

    entry.addEventListener('click', dismiss);
    close.addEventListener('click', dismiss);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onPositioningEvent, {passive: true});
    window.addEventListener('orientationchange', onPositioningEvent, {passive: true});
    window.addEventListener('scroll', onPositioningEvent, {passive: true});

    const header = document.querySelector('#osiUHeader');
    const menuButton = document.querySelector('#osiUBurger');
    if ('ResizeObserver' in window) {
      headerObserver = new ResizeObserver(schedulePositionBadge);
      if (header) headerObserver.observe(header);
      if (menuButton) headerObserver.observe(menuButton);
    }
    positionBadge();
  }

  void install();
})();
