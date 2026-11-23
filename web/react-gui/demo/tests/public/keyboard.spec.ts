import {expect, test, type Locator, type Page} from '@playwright/test';
import {mkdirSync} from 'node:fs';

test.setTimeout(240_000);

const languages = [
  {code: 'en', name: 'English', monday: 'Mon', start: 'Start guide', next: 'Next step', close: 'Close guide', reset: 'Reset', cancel: 'Keep exploring',
    startTime: 'Start', duration: 'Duration (min)', label: 'Label (optional)', weeklyTitle: '+ Weekly', weekSummary: 'Compiled week (what the valve will run)', save: 'Save', del: 'Delete', yesDelete: 'Yes, delete'},
  {code: 'de-CH', name: 'Deutsch', monday: 'Mo', start: 'Führung starten', next: 'Weiter', close: 'Führung schliessen', reset: 'Zurücksetzen', cancel: 'Weiter erkunden',
    startTime: 'Start', duration: 'Dauer (Min.)', label: 'Bezeichnung (optional)', weeklyTitle: '+ Wöchentlich', weekSummary: 'Kompilierte Woche (was das Ventil ausführt)', save: 'Speichern', del: 'Löschen', yesDelete: 'Ja, löschen'},
  {code: 'fr', name: 'Français', monday: 'Lun', start: 'Commencer le guide', next: 'Étape suivante', close: 'Fermer le guide', reset: 'Réinitialiser', cancel: 'Continuer',
    startTime: 'Début', duration: 'Durée (min)', label: 'Nom (facultatif)', weeklyTitle: '+ Hebdomadaire', weekSummary: 'Cette semaine sur la vanne', save: 'Enregistrer', del: 'Supprimer', yesDelete: 'Oui, supprimer'},
  {code: 'it', name: 'Italiano', monday: 'Lun', start: 'Avvia guida', next: 'Passaggio successivo', close: 'Chiudi guida', reset: 'Reimposta', cancel: 'Continua',
    startTime: 'Inizio', duration: 'Durata (min)', label: 'Etichetta (facoltativa)', weeklyTitle: '+ Settimanale', weekSummary: 'Settimana compilata (eseguita dalla valvola)', save: 'Salva', del: 'Elimina', yesDelete: 'Sì, elimina'},
  {code: 'es', name: 'Español', monday: 'Lun', start: 'Iniciar guía', next: 'Siguiente paso', close: 'Cerrar guía', reset: 'Reiniciar', cancel: 'Seguir explorando',
    startTime: 'Inicio', duration: 'Duración (min)', label: 'Etiqueta (opcional)', weeklyTitle: '+ Semanal', weekSummary: 'Semana compilada (lo que ejecutará la válvula)', save: 'Guardar', del: 'Eliminar', yesDelete: 'Sí, eliminar'},
  {code: 'pt', name: 'Português', monday: 'Seg', start: 'Iniciar guia', next: 'Próxima etapa', close: 'Fechar guia', reset: 'Repor', cancel: 'Continuar a explorar',
    startTime: 'Início', duration: 'Duração (min)', label: 'Etiqueta (opcional)', weeklyTitle: '+ Semanal', weekSummary: 'Semana compilada (o que a válvula executará)', save: 'Guardar', del: 'Eliminar', yesDelete: 'Sim, eliminar'},
  {code: 'lg', name: 'Luganda', monday: 'Bbalaza', start: 'Tandika ekiragiro', next: 'Ekiddako', close: 'Ggalawo ekiragiro', reset: 'Ddamu', cancel: 'Weyongere okwetegereza',
    startTime: 'Start', duration: 'Duration (min)', label: 'Label (optional)', weeklyTitle: '+ Weekly', weekSummary: 'Compiled week (what the valve will run)', save: 'Tereka', del: 'Gyawo', yesDelete: 'Yes, delete'},
];

async function tabTo(page: Page, target: Locator, description: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (await target.evaluate(element => element.ownerDocument.activeElement === element)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab did not reach ${description}`);
}

async function replaceByKeyboard(page: Page, target: Locator, value: string): Promise<void> {
  await target.press('Control+A');
  await target.pressSequentially(value);
}

for (const language of languages) {
  test(`keyboard core flow, modal containment and focus restoration in ${language.code}`, async ({page}) => {
    await page.setViewportSize({width: 1280, height: 900});
    await page.goto('/simulator/');
    await expect(page.locator('#loading')).toBeHidden({timeout: 25_000});
    const app = page.frameLocator('#app');
    const languageTrigger = app.getByRole('button', {name: 'English', exact: true});
    await tabTo(page, languageTrigger, 'the language menu');
    await page.keyboard.press('ArrowDown');
    const selectedLanguage = app.getByRole('menuitem', {name: language.name, exact: true});
    for (let index = 0; index < languages.findIndex(item => item.code === language.code); index += 1) await page.keyboard.press('ArrowDown');
    await expect(selectedLanguage).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', language.code);
    await expect(app.locator('html')).toHaveAttribute('lang', language.code);

    await page.locator('#guide-start').press('Enter');
    await expect(page.locator('#guide-panel')).toBeVisible();
    await expect(page.locator('#guide-intro')).toBeVisible();
    await expect(page.locator('#guide-next')).toBeFocused();
    await page.keyboard.press('Enter');
    for (let index = 0; index < 3; index += 1) {
      await expect(page.locator('#guide-next')).toBeEnabled({timeout: 10_000});
      await page.locator('#guide-next').press('Enter');
    }
    await expect(page.locator('#guide-next')).toBeEnabled({timeout: 10_000});
    const valve = app.getByTestId('valve-actions').first().locator('..');
    const open = valve.getByRole('button', {name: /^(Open|Öffnen|Ouvrir|Apri|Abrir|Ggulawo)$/});
    await open.press('Enter');
    const openDialog = app.getByRole('dialog');
    await expect(openDialog).toBeVisible();
    const durationInput = openDialog.getByRole('spinbutton');
    await durationInput.press('Control+A');
    await durationInput.pressSequentially('1');
    const confirmOpen = openDialog.getByRole('button').last();
    await confirmOpen.press('Enter');
    await expect(page.locator('#skip-event')).toBeVisible();

    const firstEventTime = await page.locator('#skip-event [data-skip-time]').innerText();
    await page.locator('#skip-event').press('Enter');
    await expect.poll(async () => page.locator('#skip-event [data-skip-time]').innerText()).not.toBe(firstEventTime);
    const ackState = await valve.innerText();
    await page.locator('#skip-event').press('Enter');
    await expect.poll(async () => valve.innerText()).not.toBe(ackState);

    const schedule = valve.getByRole('button', {name: /^(Schedule|Zeitplan|Programmer|Programma|Programar|Teekateeka)$/});
    await schedule.press('Enter');
    const scheduleDialog = app.getByRole('dialog');
    await expect(scheduleDialog).toBeVisible();
    for (let index = 0; index < 32; index += 1) {
      await page.keyboard.press('Tab');
      expect(await scheduleDialog.evaluate(dialog => dialog.contains(dialog.ownerDocument.activeElement)), 'Tab stays within schedule dialog').toBe(true);
    }
    for (let index = 0; index < 32; index += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await scheduleDialog.evaluate(dialog => dialog.contains(dialog.ownerDocument.activeElement)), 'Shift+Tab stays within schedule dialog').toBe(true);
    }

    const scheduleRows = scheduleDialog.locator('ul > li');
    const initialScheduleCount = await scheduleRows.count();
    const weekSummary = scheduleDialog.locator('details > summary');
    if (await weekSummary.isVisible()) await weekSummary.press('Enter');
    const weeklyStart = scheduleDialog.locator('input[type="time"]').nth(1);
    await expect(weeklyStart).toBeVisible();
    const monday = scheduleDialog.getByRole('button', {name: language.monday, exact: true});
    await monday.press('Enter');
    await tabTo(page, weeklyStart, 'the weekly start time');
    await replaceByKeyboard(page, weeklyStart, '06:15');
    const minutes = scheduleDialog.locator('input[id^="weekly-duration-"]');
    await replaceByKeyboard(page, minutes, '2');
    const weeklyLabel = scheduleDialog.locator('input[id^="weekly-label-"]');
    await replaceByKeyboard(page, weeklyLabel, `Keyboard ${language.code}`);
    await scheduleDialog.getByRole('button', {name: language.save, exact: true}).first().press('Enter');
    await expect.poll(() => scheduleRows.count()).toBeGreaterThan(initialScheduleCount);
    const addedScheduleCount = await scheduleRows.count();

    const deleteButton = scheduleRows.last().getByRole('button', {name: language.del, exact: true});
    await deleteButton.press('Enter');
    const nested = app.getByRole('alertdialog');
    await expect(nested).toBeVisible();
    await page.keyboard.press('Tab');
    expect(await nested.evaluate(dialog => dialog.contains(dialog.ownerDocument.activeElement))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await nested.evaluate(dialog => dialog.contains(dialog.ownerDocument.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(nested).toBeHidden();
    await expect(deleteButton).toBeFocused();
    await deleteButton.press('Enter');
    await app.getByRole('alertdialog').getByRole('button', {name: language.yesDelete, exact: true}).press('Enter');
    await expect.poll(() => scheduleRows.count()).toBeLessThan(addedScheduleCount);

    await page.keyboard.press('Escape');
    await expect(scheduleDialog).toBeHidden();
    await expect(schedule).toBeFocused();
    await page.locator('#reset').press('Enter');
    await expect(page.locator('#reset-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#reset-dialog')).toBeHidden();
    await expect(page.locator('#reset')).toBeFocused();
    await page.locator('#reset').press('Enter');
    await page.locator('#reset-confirm').press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', language.code);
    await expect(app.locator('html')).toHaveAttribute('lang', language.code);
  });
}

test('normal Tab reaches the schedule creation form and compiled week disclosure', async ({page}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto('/simulator/');
  await expect(page.locator('#loading')).toBeHidden({timeout: 25_000});
  const app = page.frameLocator('#app');
  const valve = app.getByTestId('valve-actions').first().locator('..');
  const opener = valve.getByRole('button', {name: 'Schedule', exact: true});
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = app.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  const start = dialog.locator('input[type="time"]').nth(1);
  const label = dialog.locator('input[id^="weekly-label-"]');
  const summary = dialog.locator('details > summary');
  const reached = new Set<string>();
  for (let index = 0; index < 100 && reached.size < 3; index += 1) {
    await page.keyboard.press('Tab');
    if (await start.evaluate(element => element.ownerDocument.activeElement === element)) reached.add('start');
    if (await label.evaluate(element => element.ownerDocument.activeElement === element)) reached.add('label');
    if (await summary.evaluate(element => element.ownerDocument.activeElement === element)) {
      reached.add('summary');
      await page.keyboard.press('Enter');
      break;
    }
  }
  expect([...reached].sort()).toEqual(['label', 'start', 'summary']);
  await expect(summary.locator('..')).toHaveAttribute('open', '');
  await expect(dialog.locator('input[id^="weekly-label-"]')).toBeVisible();
  if (testInfo.project.name === 'chromium-desktop') {
    mkdirSync('/tmp/osi-simulator-ux-evidence', {recursive: true});
    await page.screenshot({path: '/tmp/osi-simulator-ux-evidence/keyboard-dialog-compiled-week.png', fullPage: true});
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  testInfo.annotations.push({type: 'tab-browser', description: testInfo.project.name});
});
