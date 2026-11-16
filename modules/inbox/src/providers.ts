/**
 * The mail services the guided "connect my email" flow knows by name (ws/email). Each one's IMAP and SMTP servers are
 * fixed here and never come from a person or an agent: for a named service the owner types only their address and
 * the app password the service made for PasaBot. "Other" is the manual form (hosts and ports under Technical words).
 *
 * Pure data and string helpers, no imports: the web flow reads the same table (help links, how the code looks).
 * Every help link opens the service's own page in the owner's own browser; PasaBot never opens a sign-in itself.
 */

export type Tls = 'implicit' | 'starttls';
export interface ServiceHosts {
  imapHost: string;
  imapPort: number;
  imapTls: Tls;
  smtpHost: string;
  smtpPort: number;
  smtpTls: Tls;
}
export const NAMED_SERVICES = ['gmail', 'outlook', 'yahoo', 'icloud'] as const;
export type NamedService = (typeof NAMED_SERVICES)[number];
export type ServiceId = NamedService | 'other';
export const SERVICE_IDS: readonly ServiceId[] = [...NAMED_SERVICES, 'other'];

export interface Service {
  hosts: ServiceHosts;
  /** the service's own page where the owner makes an app password */
  appPasswordUrl: string;
  /** where the owner turns on 2-step verification (an app password needs it at every named service) */
  twoStepUrl: string;
  /** the service's own sign-up page (only Gmail is offered for a new mailbox) */
  signupUrl?: string;
}

export const SERVICES: Record<NamedService, Service> = {
  gmail: {
    hosts: {
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapTls: 'implicit',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpTls: 'implicit',
    },
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    twoStepUrl: 'https://myaccount.google.com/signinoptions/twosv',
    signupUrl: 'https://accounts.google.com/signup',
  },
  outlook: {
    hosts: {
      imapHost: 'outlook.office365.com',
      imapPort: 993,
      imapTls: 'implicit',
      smtpHost: 'smtp-mail.outlook.com',
      smtpPort: 587,
      smtpTls: 'starttls',
    },
    appPasswordUrl: 'https://account.live.com/proofs/AppPassword',
    twoStepUrl: 'https://account.live.com/proofs/manage/additional',
  },
  yahoo: {
    hosts: {
      imapHost: 'imap.mail.yahoo.com',
      imapPort: 993,
      imapTls: 'implicit',
      smtpHost: 'smtp.mail.yahoo.com',
      smtpPort: 465,
      smtpTls: 'implicit',
    },
    appPasswordUrl: 'https://login.yahoo.com/myaccount/security/app-password',
    twoStepUrl: 'https://login.yahoo.com/myaccount/security/two-step-verification',
  },
  icloud: {
    hosts: {
      imapHost: 'imap.mail.me.com',
      imapPort: 993,
      imapTls: 'implicit',
      smtpHost: 'smtp.mail.me.com',
      smtpPort: 587,
      smtpTls: 'starttls',
    },
    appPasswordUrl: 'https://account.apple.com/account/manage',
    twoStepUrl: 'https://support.apple.com/102660',
  },
};

export const isNamedService = (id: unknown): id is NamedService =>
  typeof id === 'string' && (NAMED_SERVICES as readonly string[]).includes(id);

/** Every named service shows its app password as 16 letters, in groups (spaces at Google, dashes at Apple). */
export const CODE_LETTERS = 16;

/**
 * The app password as typed or pasted: spaces (any kind), dashes and line breaks between the groups dropped, letters
 * made small (the services show them small). `ok` is false when what is left is not 16 letters a-z.
 */
export function normaliseCode(raw: string): { code: string; ok: boolean } {
  const code = raw.replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000\-\u2010-\u2015]+/g, '').toLowerCase();
  return { code, ok: code.length === CODE_LETTERS && /^[a-z]+$/.test(code) };
}

/** A plain email address shape: one @, something on both sides, a dot in the domain, no spaces or brackets. */
export function looksLikeAddress(v: string): boolean {
  const s = v.trim();
  if (s.length < 5 || s.length > 254) return false;
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return false;
  const domain = s.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  return !/[\s<>()[\],;:"\\]/.test(s);
}

/**
 * The named service an address belongs to, from its domain (`null`: a domain no named service owns, e.g. a company's
 * own domain, which may still be run by one of them, like Google Workspace).
 */
const DOMAINS: Record<NamedService, RegExp> = {
  gmail: /^(gmail|googlemail)\.com$/,
  outlook: /^(outlook|hotmail|live|msn|passport)\.[a-z.]{2,7}$/,
  yahoo: /^(yahoo|ymail|rocketmail)\.[a-z.]{2,7}$/,
  icloud: /^(icloud|me|mac)\.com$/,
};
export function serviceForAddress(address: string): NamedService | null {
  const domain = address.trim().toLowerCase().split('@')[1] ?? '';
  for (const id of NAMED_SERVICES) if (DOMAINS[id].test(domain)) return id;
  return null;
}

/**
 * Three address ideas for a new Gmail from the business or team name the owner typed: lowercase letters, digits and
 * dots, 6-30 characters. Only ideas: nothing here checks whether one is free. No name, no ideas.
 */
export function addressIdeas(names: string[]): string[] {
  const words = names
    .flatMap((n) =>
      n
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/),
    )
    .filter((w) => w.length >= 2)
    .slice(0, 3);
  if (!words.length) return [];
  const first = words.join('');
  const dotted = words.join('.');
  const year = new Date().getFullYear() % 100;
  const raw = [`${first}.help`, `${dotted}.team`, `${first}${year}`];
  const fit = (s: string) => {
    let x = s.replace(/\.{2,}/g, '.').replace(/^\.|\.$/g, '');
    if (x.length > 30) x = x.slice(0, 30).replace(/\.$/, '');
    while (x.length < 6) x += 'x';
    return `${x}@gmail.com`;
  };
  return [...new Set(raw.map(fit))].slice(0, 3);
}
