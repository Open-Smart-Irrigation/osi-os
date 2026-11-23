import en from './locales/en.json';
import deCH from './locales/de-CH.json';
import fr from './locales/fr.json';
import it from './locales/it.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import lg from './locales/lg.json';
import {isDemoLanguage, type DemoLanguage} from '../protocol';

export type {DemoLanguage};

const messages: Record<DemoLanguage, typeof en> = {en, 'de-CH': deCH, fr, it, es, pt, lg};

export function normalizeDemoLanguage(value: string): DemoLanguage {
  if (isDemoLanguage(value)) return value;
  const base = value.toLowerCase().split('-')[0];
  return isDemoLanguage(base) ? base : 'en';
}

export function getDemoMessages(language: DemoLanguage): typeof en {
  return messages[language];
}
