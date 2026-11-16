/**
 * The one host allow-list matcher (store packs, the browser port and the Shop page share it): a `*.` pattern allows
 * the suffix itself and its subdomains, an exact pattern only itself; a look-alike or a suffix-stuffed host never.
 */
import { describe, expect, it } from 'vitest';
import { hostAllowed, urlAllowed } from './index.js';

describe('host allow-list matcher', () => {
  it('"*.shopee.ph" and "shopee.ph" never match evilshopee.ph, shopee.ph.evil.com or xshopee.ph', () => {
    for (const patterns of [['*.shopee.ph'], ['shopee.ph'], ['*.shopee.ph', 'shopee.ph']])
      for (const host of ['evilshopee.ph', 'shopee.ph.evil.com', 'xshopee.ph', 'shopee.phx', 'ph']) {
        expect(hostAllowed(host, patterns), `${host} ${patterns}`).toBe(false);
        expect(urlAllowed(`https://${host}/p/1`, patterns), `${host} ${patterns}`).toBe(false);
      }
  });
  it('allows the exact host, and with "*." the suffix itself and any subdomain, in any case', () => {
    expect(hostAllowed('shopee.ph', ['shopee.ph'])).toBe(true);
    expect(hostAllowed('www.shopee.ph', ['shopee.ph'])).toBe(false);
    for (const host of ['shopee.ph', 'www.shopee.ph', 'cf.img.shopee.ph', 'WWW.Shopee.PH'])
      expect(hostAllowed(host, ['*.shopee.ph']), host).toBe(true);
    expect(hostAllowed('x.shopee.ph', ['*.'])).toBe(false);
  });
  it('urlAllowed takes only http(s) without user info', () => {
    expect(urlAllowed('https://www.shopee.ph/x', ['*.shopee.ph'])).toBe(true);
    expect(urlAllowed('http://shopee.ph/x', ['shopee.ph'])).toBe(true);
    for (const u of [
      'javascript:alert(1)',
      'ftp://shopee.ph/',
      'https://u:p@shopee.ph/',
      'https://shopee.ph@evil.com/',
      'nope',
      42,
    ])
      expect(urlAllowed(u, ['*.shopee.ph', 'shopee.ph']), String(u)).toBe(false);
  });
});
