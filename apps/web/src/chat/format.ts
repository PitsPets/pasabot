/** Dates and times the chat shows, always in the app's language (every locale; `displayLocale`). */
import { displayLocale } from '@pasabot/i18n';

/** a message's time */
export const time = (ms: number, lang: string) =>
  new Date(ms).toLocaleTimeString(displayLocale(lang), { hour: 'numeric', minute: '2-digit' });

/** the agent's "since" date */
export const sinceText = (ms: number, lang: string) =>
  new Date(ms).toLocaleDateString(displayLocale(lang), { month: 'short', day: 'numeric' });
