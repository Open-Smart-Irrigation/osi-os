import type {i18n as I18nInstance} from 'i18next';

export const PUBLIC_SUPPORT_RECEIPTS: Record<string, string> = {
  en: 'Saved in this demo session. No request was sent.',
  'de-CH': 'In dieser Demo-Sitzung gespeichert. Es wurde keine Anfrage gesendet.',
  fr: 'Enregistrée dans cette session de démonstration. Aucune demande n’a été envoyée.',
  it: 'Salvata in questa sessione demo. Non è stata inviata alcuna richiesta.',
  es: 'Guardada en esta sesión de demostración. No se ha enviado ninguna solicitud.',
  pt: 'Guardado nesta sessão de demonstração. Nenhum pedido foi enviado.',
  lg: 'Kiterekeddwa mu kwolesa kuno. Tewali kusaba kutumiddwa.',
};

export function applyPublicSupportReceiptCopy(instance: I18nInstance): void {
  for (const [language, message] of Object.entries(PUBLIC_SUPPORT_RECEIPTS)) {
    instance.addResource(language, 'settings', 'requestSaved', message);
  }
}
