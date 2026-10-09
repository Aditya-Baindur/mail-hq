import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { findTextMatches, highlightDocument } from '../lib/search-highlight';

describe('search highlights', () => {
  it('finds repeated, case-insensitive words and literal punctuation without regex operators', () => {
    const text = 'Invoice INVOICE invoice. Total: $100.00 (a+b) [x] \\path 100% AB_42';
    expect(findTextMatches(text, 'invoice')).toHaveLength(3);
    for (const query of ['$100.00', '(a+b)', '[x]', '\\path', '100%', 'AB_42']) {
      const matches = findTextMatches(text, query);
      expect(matches).toHaveLength(1);
      expect(text.slice(matches[0].start, matches[0].end)).toBe(query);
    }
    expect(findTextMatches(text, '.*')).toEqual([]);
    expect(findTextMatches(text, '  \n ')).toEqual([]);
  });
  it('preserves Unicode offsets and matches whitespace-normalized phrases', () => {
    const text = '🦊 CAFÉ\n\tmeeting\u00a0tomorrow — café meeting tomorrow';
    const matches = findTextMatches(text, 'café   meeting tomorrow');
    expect(matches.map((m) => text.slice(m.start, m.end))).toEqual(['CAFÉ\n\tmeeting\u00a0tomorrow', 'café meeting tomorrow']);
    expect(findTextMatches('🦊x🦊', '🦊')).toEqual([{ start: 0, end: 2 }, { start: 3, end: 5 }]);
  });
  it('highlights phrases across inline formatting without breaking links or markup', () => {
    const dom = new JSDOM('<p>A <b>Star</b>ling &amp; <a href="https://example.com/Orchid">Orchid</a> launch.</p><p>starling &amp; orchid again</p>');
    const { document } = dom.window;
    const before = document.body.textContent;
    const groups = highlightDocument(document.body, 'starling & orchid');
    expect(groups).toHaveLength(2);
    expect(groups[0].map((m) => m.textContent).join('')).toBe('Starling & Orchid');
    expect(document.querySelector('b > mark')?.textContent).toBe('Star');
    expect(document.querySelector('a > mark')?.textContent).toBe('Orchid');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('https://example.com/Orchid');
    expect(document.body.textContent).toBe(before);
    dom.window.close();
  });
  it('treats block and line-break boundaries as spaces, not concatenated words', () => {
    const dom = new JSDOM('<div>alpha</div><span>beta</span><p>alpha<br>beta</p>');
    const { body } = dom.window.document;
    expect(highlightDocument(body, 'alphabeta')).toHaveLength(0);
    expect(highlightDocument(body, 'alpha beta')).toHaveLength(2);
    dom.window.close();
  });
  it('does not highlight attributes, styles, scripts, hidden elements or image alt text', () => {
    const dom = new JSDOM('<style>.invisible{display:none}</style><p title="needle">Visible</p><a href="https://example.com/needle">Link</a><script>needle</script><div hidden>needle</div><div class="invisible">needle</div><div aria-hidden="true">needle</div><img alt="needle"><p>needle</p>');
    expect(highlightDocument(dom.window.document.body, 'needle')).toHaveLength(1);
    expect(dom.window.document.querySelector('script')?.textContent).toBe('needle');
    dom.window.close();
  });
  it('replaces and clears earlier highlights while preserving original email text', () => {
    const dom = new JSDOM('<p>first <b>second</b> first second</p>');
    const { body } = dom.window.document;
    const original = body.innerHTML;
    expect(highlightDocument(body, 'first')).toHaveLength(2);
    expect(highlightDocument(body, 'second')).toHaveLength(2);
    expect(body.querySelectorAll('mark mark')).toHaveLength(0);
    expect(highlightDocument(body, '')).toHaveLength(0);
    expect(body.innerHTML).toBe(original);
    dom.window.close();
  });
  it('cannot turn search input or escaped email text into executable markup', () => {
    const dom = new JSDOM('');
    const purifier = createDOMPurify(dom.window as unknown as Window & typeof globalThis);
    const { body } = dom.window.document;
    body.innerHTML = purifier.sanitize('<img src=x onerror="alert(1)"><script>alert(1)</script><p>&lt;img src=x onerror=alert(1)&gt;</p>');
    const groups = highlightDocument(body, '<img src=x onerror=alert(1)>');
    expect(groups).toHaveLength(1);
    expect(groups[0][0].textContent).toBe('<img src=x onerror=alert(1)>');
    expect(body.querySelectorAll('img')).toHaveLength(1);
    expect(body.querySelector('[onerror],script,mark img')).toBeNull();
    dom.window.close();
  });
});
