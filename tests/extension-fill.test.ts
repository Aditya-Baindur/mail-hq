// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://career17.sapsf.com/login"}
import { beforeEach, describe, expect, it } from 'vitest';
import { fillForm, pickFillFrame } from '../extension/security.js';

const ORIGIN = 'https://career17.sapsf.com';
const SECRET = 'SapPolicySecret9!';

beforeEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/login');
  const proto = HTMLElement.prototype;
  proto.getClientRects = function getClientRects() {
    if (this.hasAttribute('hidden') || this.dataset.concealed != null)
      return [] as unknown as DOMRectList;
    const style = getComputedStyle(this);
    if (style.display === 'none' || style.visibility === 'hidden')
      return [] as unknown as DOMRectList;
    return [{ width: 120, height: 24 }] as unknown as DOMRectList;
  };
  proto.getBoundingClientRect = function getBoundingClientRect() {
    const rects = this.getClientRects();
    return (rects[0] || { width: 0, height: 0 }) as DOMRect;
  };
  Object.defineProperty(proto, 'offsetParent', {
    configurable: true,
    get() {
      return this.hasAttribute('hidden') || this.dataset.concealed != null ? null : document.body;
    },
  });
});

function mount(html: string) {
  document.body.innerHTML = html;
}

function resultOf(mode: 'login' | 'signup' | 'new-password' = 'login', password = SECRET) {
  return fillForm({ origin: ORIGIN, username: 'ada', email: 'ada@example.com', password, mode });
}

describe('extension fill', () => {
  it('keeps the frame check inside the injected function and ignores hidden password fields', () => {
    expect(fillForm.toString()).toContain('CROSS_ORIGIN_FRAME');
    expect(fillForm.toString()).not.toContain('pickFillFrame');
    mount(`
      <form method="post" action="${ORIGIN}/login">
        <input type="password" hidden autocomplete="current-password" />
        <input type="password" style="display:none" />
        <input type="password" autocomplete="current-password" />
        <input name="username" autocomplete="username" />
      </form>`);
    const result = resultOf();
    expect(result).toEqual({ ok: true, fields: 1 });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const fields = [...document.querySelectorAll<HTMLInputElement>('input')];
    expect(fields.filter((field) => field.value === SECRET)).toHaveLength(1);
    expect(document.querySelector<HTMLInputElement>('[name=username]')!.value).toBe('ada');
  });

  it('fills a signup field that is the only password and is mislabeled current-password', () => {
    mount(`
      <form method="post" action="${ORIGIN}/signup">
        <input type="password" autocomplete="current-password" />
        <input type="email" name="email" />
      </form>`);
    const result = resultOf('signup');
    expect(result).toMatchObject({ ok: true, fields: 1 });
    expect(document.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe(SECRET);
    expect(document.querySelector<HTMLInputElement>('input[type=email]')!.value).toBe(
      'ada@example.com',
    );
  });

  it('does not treat a current-password field as the signup password when a new one is present', () => {
    mount(`
      <form method="post" action="${ORIGIN}/signup">
        <input type="password" autocomplete="current-password" />
        <input type="password" autocomplete="new-password" />
      </form>`);
    expect(resultOf('signup')).toMatchObject({ ok: true, fields: 1 });
    const [current, fresh] = [
      ...document.querySelectorAll<HTMLInputElement>('input[type=password]'),
    ];
    expect(current.value).toBe('');
    expect(fresh.value).toBe(SECRET);
  });

  it('refuses an ambiguous login and a form that would submit off-site or by GET', () => {
    mount(`
      <form method="post" action="${ORIGIN}/login">
        <input type="password" />
        <input type="password" />
      </form>`);
    expect(resultOf()).toEqual({ ok: false, code: 'AMBIGUOUS_PASSWORD_FIELDS' });
    mount(`<form method="get" action="${ORIGIN}/login"><input type="password" /></form>`);
    expect(resultOf()).toEqual({ ok: false, code: 'UNSAFE_FORM_DESTINATION' });
    mount(`<form method="post" action="https://evil.test/login"><input type="password" /></form>`);
    expect(resultOf()).toEqual({ ok: false, code: 'UNSAFE_FORM_DESTINATION' });
    mount(`<form method="post" action="${ORIGIN}/login"><input type="password" /></form>`);
    expect(fillForm({ origin: 'https://evil.test', password: SECRET })).toEqual({
      ok: false,
      code: 'ORIGIN_MISMATCH',
    });
  });

  it('fills one formless password field beside one action and does not submit', () => {
    const clicked: string[] = [];
    mount(`
      <div id="box">
        <input type="password" />
        <input name="username" autocomplete="username" />
        <button type="button" id="go">Continue</button>
        <button type="button" aria-label="Show password">Show</button>
        <a role="button" href="https://evil.test/out">Leave</a>
      </div>`);
    document.getElementById('go')!.addEventListener('click', () => clicked.push('go'));
    const result = resultOf();
    expect(result).toEqual({ ok: true, fields: 1, formless: true });
    expect(clicked).toEqual([]);
    expect(document.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('refuses a formless field with two real actions or when the page clears the value', () => {
    mount(
      `<div><input type="password" /><button type="button">Save</button><button type="button">Other</button></div>`,
    );
    expect(resultOf()).toEqual({ ok: false, code: 'FORMLESS_NO_CLEAR_SUBMIT' });
    mount(`<form method="post" action="${ORIGIN}/login"><input type="password" id="pw" /></form>`);
    document.getElementById('pw')!.addEventListener('input', (event) => {
      expect((event as InputEvent).data).toBeNull();
      (event.target as HTMLInputElement).value = '';
    });
    expect(resultOf()).toEqual({ ok: false, code: 'PAGE_REJECTED_FILL' });
  });

  it('refuses a cross-origin frame and allows one same-origin frame', () => {
    Object.defineProperty(window, 'top', {
      configurable: true,
      get: () => ({ location: { origin: 'https://evil.test' } }),
    });
    mount(`<form method="post" action="${ORIGIN}/login"><input type="password" /></form>`);
    expect(resultOf()).toEqual({ ok: false, code: 'CROSS_ORIGIN_FRAME' });
    Object.defineProperty(window, 'top', { configurable: true, get: () => window });
    expect(
      pickFillFrame([
        { frameId: 0, documentId: 'top', result: { ok: false, code: 'CROSS_ORIGIN_FRAME' } },
        { frameId: 7, documentId: 'doc-7', result: { ok: true, probe: true, count: 1 } },
      ]),
    ).toEqual({ ok: true, frameId: 7, documentId: 'doc-7' });
    expect(
      pickFillFrame([
        { frameId: 0, documentId: 'a', result: { ok: true, probe: true, count: 1 } },
        { frameId: 1, documentId: 'b', result: { ok: true, probe: true, count: 2 } },
      ]),
    ).toEqual({ ok: false, code: 'MULTIPLE_PASSWORD_FRAMES' });
    expect(pickFillFrame([{ frameId: 0, result: { ok: true, probe: true, count: 0 } }])).toEqual({
      ok: false,
      code: 'NO_SUPPORTED_FORM',
    });
    const probe = fillForm({ origin: ORIGIN, mode: 'login', probe: true });
    expect(probe).toEqual({ ok: true, probe: true, top: true, count: 1 });
    expect(JSON.stringify(probe)).not.toContain(SECRET);
  });
});
