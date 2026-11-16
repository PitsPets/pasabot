/** Token values mirrored from styles.css (for code that needs them outside CSS, e.g. the PWA theme colour). */
export interface ThemeTokens {
  bg: string;
  panel: string;
  soft: string;
  ink: string;
  ink2: string;
  muted: string;
  line: string;
  primary: string;
  primaryInk: string;
  ask: string;
  askLine: string;
  askInk: string;
  signal: string;
  work: string;
  idle: string;
}

export const tokens: { light: ThemeTokens; dark: ThemeTokens } = {
  light: {
    bg: '#fbf6ec',
    panel: '#ffffff',
    soft: '#f3ecdd',
    ink: '#1b2a22',
    ink2: '#44524a',
    muted: '#5c675f',
    line: '#e3d9c5',
    primary: '#14432f',
    primaryInk: '#ffffff',
    ask: '#fff0c9',
    askLine: '#e0a52f',
    askInk: '#5a3e00',
    signal: '#f0b23a',
    work: '#1e8a5a',
    idle: '#8a918c',
  },
  dark: {
    bg: '#0e1713',
    panel: '#15211b',
    soft: '#1c2a23',
    ink: '#eef1ea',
    ink2: '#c3cbc4',
    muted: '#9aa69f',
    line: '#2b3c33',
    primary: '#bfe8c9',
    primaryInk: '#0e1713',
    ask: '#2b2410',
    askLine: '#f0b23a',
    askInk: '#f6d58a',
    signal: '#f0b23a',
    work: '#5fd39a',
    idle: '#7c8780',
  },
};
