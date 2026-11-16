import { roleAllows, WEB_SLOTS, type WebModule } from '@pasabot/core/web';
import { createI18n } from '@pasabot/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadWebLocales, loadWebModules } from './modules.js';
import {
  DockPanelSlots,
  HeaderWidgetSlots,
  indexSlots,
  MessageBlockView,
  ModuleRoute,
  navFor,
  OnboardingSlots,
  RunEventView,
  SettingsSlots,
  settingsFor,
  TopBarSlots,
} from './slots.js';

const Page = () => <p data-slot="p">page</p>;

describe('test:sdk (web)', () => {
  const mods = loadWebModules();
  const slots = indexSlots(mods);
  const html = (el: React.ReactElement) => renderToStaticMarkup(el);

  it('discovers modules/_example/web by glob and it fills every slot', () => {
    const ex = mods.find((m) => m.id === '_example');
    expect(ex).toBeDefined();
    for (const slot of WEB_SLOTS) {
      const v = ex![slot];
      expect(v, slot).toBeDefined();
      expect(Array.isArray(v) ? v.length : Object.keys(v as object).length, slot).toBeGreaterThan(0);
    }
  });

  it('renders the page, block, run event, settings, header, dock and onboarding slots', () => {
    expect(html(<ModuleRoute slots={slots} path="/example" />)).toContain('data-slot="route"');
    expect(html(<ModuleRoute slots={slots} path="/nope" />)).toBe('');
    expect(
      html(<MessageBlockView slots={slots} block={{ kind: '_example.note', v: 1, data: { text: 'hi' } }} />),
    ).toBe('<aside data-slot="block">hi</aside>');
    expect(
      html(<MessageBlockView slots={slots} block={{ kind: 'nobody.thing', v: 1, data: {} }} />),
    ).toContain('data-block-fallback="nobody.thing"');
    expect(
      html(<RunEventView slots={slots} event={{ runId: 'r', n: 0, type: 'example.step', data: {} }} />),
    ).toContain('data-slot="run-event"');
    expect(html(<SettingsSlots slots={slots} />)).toContain('data-slot="settings"');
    expect(html(<HeaderWidgetSlots slots={slots} chatId="c1" />)).toContain('c1');
    expect(html(<DockPanelSlots slots={slots} />)).toContain('data-slot="dock"');
    expect(html(<OnboardingSlots slots={slots} next={() => {}} />)).toContain('data-slot="onboarding"');
    expect(html(<TopBarSlots slots={slots} compact />)).toContain('data-slot="top-bar"');
    expect(slots.navItems.map((n) => n.to)).toContain('/example');
    expect(slots.composerActions.map((c) => c.id)).toContain('example-note');
  });

  it('merges the module locale under its namespace in en and fil', () => {
    const res = loadWebLocales();
    expect(createI18n(res, 'en').t('_example:nav')).toBe('Example');
    expect(createI18n(res, 'fil').t('_example:nav')).toBe('Halimbawa');
    expect(createI18n(res, 'fil').t('common.retry')).toBe('Subukan ulit');
  });

  it('W39: an entry without roles is owner only; members and guests see only what a module opens to them', () => {
    expect(roleAllows(undefined, 'owner')).toBe(true);
    expect(roleAllows(undefined, 'member')).toBe(false);
    expect(roleAllows(undefined, null)).toBe(false);
    expect(roleAllows(['owner', 'member'], 'member')).toBe(true);
    expect(roleAllows(['owner', 'member'], 'guest')).toBe(false);
    const m: WebModule = {
      id: 'roles',
      routes: [
        { path: '/own', component: Page },
        { path: '/all', component: Page, roles: ['owner', 'member', 'guest'] },
        { path: '/open', component: Page, public: true },
      ],
      navItems: [
        { id: 'own', labelKey: 'x', to: '/own' },
        { id: 'all', labelKey: 'x', to: '/all', roles: ['owner', 'member', 'guest'] },
      ],
      settingsSections: [{ id: 's', labelKey: 'x', component: Page }],
      topBarItems: [{ id: 'stop', component: () => <b data-slot="stop">stop</b> }],
    };
    const s = indexSlots([m]);
    expect(navFor(s, 'owner').map((n) => n.id)).toEqual(['own', 'all']);
    expect(navFor(s, 'member').map((n) => n.id)).toEqual(['all']);
    expect(navFor(s, 'guest').map((n) => n.id)).toEqual(['all']);
    expect(settingsFor(s, 'member')).toEqual([]);
    const denied = <i data-denied="1">no</i>;
    expect(html(<ModuleRoute slots={s} path="/own" viewer="member" denied={denied} />)).toContain(
      'data-denied',
    );
    expect(html(<ModuleRoute slots={s} path="/own" viewer="owner" denied={denied} />)).toContain(
      'data-slot="p"',
    );
    expect(html(<ModuleRoute slots={s} path="/all" viewer="guest" denied={denied} />)).toContain(
      'data-slot="p"',
    );
    expect(html(<ModuleRoute slots={s} path="/open" viewer="guest" denied={denied} />)).toContain(
      'data-slot="p"',
    );
    expect(html(<SettingsSlots slots={s} viewer="member" />)).toBe('');
    expect(html(<TopBarSlots slots={s} viewer="member" />)).toBe('');
    expect(html(<TopBarSlots slots={s} viewer="owner" />)).toContain('data-slot="stop"');
  });

  it('W39: Shop settings and the Inbox are owner only: no nav entry, settings section or page for a member or guest', () => {
    const inbox = mods.find((m) => m.id === 'inbox');
    const shop = mods.find((m) => m.id === 'shop');
    expect(inbox?.navItems?.some((n) => n.to === '/inbox')).toBe(true);
    expect(shop?.settingsSections?.some((x) => x.id === 'shop')).toBe(true);
    expect(navFor(slots, 'owner').some((n) => n.to === '/inbox')).toBe(true);
    expect(settingsFor(slots, 'owner').some((x) => x.id === 'shop')).toBe(true);
    const denied = <i data-denied="1">no</i>;
    for (const role of ['member', 'guest'] as const) {
      expect(
        navFor(slots, role).some((n) => n.to === '/inbox'),
        role,
      ).toBe(false);
      expect(
        settingsFor(slots, role).some((x) => x.id === 'shop' || x.id === 'inbox'),
        role,
      ).toBe(false);
      expect(html(<ModuleRoute slots={slots} path="/inbox" viewer={role} denied={denied} />), role).toContain(
        'data-denied',
      );
      expect(html(<SettingsSlots slots={slots} viewer={role} />), role).not.toContain('shop-');
    }
  });
});
