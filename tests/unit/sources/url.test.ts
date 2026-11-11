import { describe, expect, it } from 'vitest';
import { InvalidUrlError, normalizeUrl } from '../../../src/sources/url.js';

const n = (u: string) => normalizeUrl(u).urlNorm;

describe('normalizeUrl', () => {
  it('lowercases host, drops www, fragment, default port and trailing slash', () => {
    expect(n('HTTPS://WWW.Example.COM:443/Pricing/#plans')).toBe('https://example.com/Pricing');
    expect(n('http://example.com:80/')).toBe('http://example.com');
  });

  it('keeps a non-default port', () => {
    expect(n('https://example.com:8443/p')).toBe('https://example.com:8443/p');
  });

  it('removes only tracking parameters', () => {
    expect(n('https://e.com/p?utm_source=a&UTM_Medium=b&gclid=1&fbclid=2&msclkid=3&mc_cid=4')).toBe(
      'https://e.com/p',
    );
    expect(n('https://e.com/p?plan=pro&currency=EUR&utm_campaign=x&country=DE')).toBe(
      'https://e.com/p?country=DE&currency=EUR&plan=pro',
    );
  });

  it('keeps meaningful parameters that merely look like tracking (bare ref, id, region)', () => {
    expect(n('https://e.com/p?ref=main&id=7&region=us')).toBe(
      'https://e.com/p?id=7&ref=main&region=us',
    );
  });

  it('treats parameter order as irrelevant and different values as different sources', () => {
    expect(n('https://e.com/p?b=2&a=1')).toBe(n('https://e.com/p?a=1&b=2'));
    expect(n('https://e.com/p?currency=USD')).not.toBe(n('https://e.com/p?currency=EUR'));
  });

  it('strips credentials from both url and urlNorm', () => {
    const r = normalizeUrl('https://user:secret@example.com/p');
    expect(r.url).not.toContain('secret');
    expect(r.url).not.toContain('user');
    expect(r.urlNorm).toBe('https://example.com/p');
  });

  it('resolves dot segments and folds IDN hosts', () => {
    expect(n('https://example.com/a/../b/./c')).toBe('https://example.com/b/c');
    expect(normalizeUrl('https://BÜCHER.example/').domain).toBe('xn--bcher-kva.example');
  });

  it('reports the domain without port or www', () => {
    expect(normalizeUrl('https://www.shop.example.com:8443/x').domain).toBe('shop.example.com');
  });

  it.each([
    'javascript:alert(1)',
    'ftp://example.com/x',
    'file:///etc/passwd',
    'data:text/html,hi',
    'mailto:a@b.c',
    '',
    'not a url',
    '//example.com/x',
    'https://',
    `https://example.com/${'a'.repeat(3000)}`,
  ])('rejects %s', (bad) => {
    expect(() => normalizeUrl(bad)).toThrow(InvalidUrlError);
  });

  it('handles IPv6 hosts, empty query and repeated parameters', () => {
    expect(n('http://[::1]:3000/x?')).toBe('http://[::1]:3000/x');
    expect(n('https://e.com/p?a=2&a=1')).toBe('https://e.com/p?a=1&a=2');
  });
});
