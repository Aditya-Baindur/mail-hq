/** Runs in Chrome's isolated world. Never returns field values.
 * `origin` is the top page's origin, which the vault matched the credential
 * against. `probe: true` only counts visible password fields; no credential
 * is passed in that phase. This function is serialized by
 * chrome.scripting.executeScript, so helpers it needs stay inside it.
 * pickFillFrame runs in the service worker and is not injected. */
export function fillForm({ origin, username, password, email, mode = 'login', probe = false }) {
  if (location.origin !== origin || location.protocol !== 'https:')
    return { ok: false, code: 'ORIGIN_MISMATCH' };
  if (window.top !== window) {
    // A same-origin frame nested under a foreign frame is refused too.
    // Cross-origin frames throw when reading the top location and are refused.
    const ancestors = location.ancestorOrigins;
    let topOrigin = null;
    try {
      topOrigin = window.top.location.origin;
    } catch {
      topOrigin = null;
    }
    if (
      !ancestors ||
      !ancestors.length ||
      ![...ancestors].every((value) => value === origin) ||
      topOrigin !== origin
    )
      return { ok: false, code: 'CROSS_ORIGIN_FRAME' };
  }
  // A password field counts only when a person could see and type into it.
  // Hidden login-modal fields (freelancer.com/signup) must not make a visible
  // signup field look ambiguous.
  const visible = (input) => {
    if (input.type === 'hidden' || input.disabled || input.readOnly || input.hidden) return false;
    if (input.closest('[hidden], [aria-hidden="true"], [inert], dialog:not([open])')) return false;
    if (input.getClientRects().length === 0) return false;
    const box = input.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return false;
    const own = getComputedStyle(input);
    if (input.offsetParent === null && own.position !== 'fixed') return false;
    if (own.visibility === 'hidden' || own.visibility === 'collapse') return false;
    for (let el = input; el; el = el.parentElement || el.getRootNode?.()?.host || null) {
      const style = el === input ? own : getComputedStyle(el);
      if (style.display === 'none' || Number.parseFloat(style.opacity) === 0) return false;
    }
    return true;
  };
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
  if (probe) return { ok: true, probe: true, top: window.top === window, count: passwords.length };
  const eligibleFor = (fields) => {
    if (mode === 'new-password') return fields.filter((p) => p.autocomplete === 'new-password');
    if (mode === 'signup') {
      const fresh = fields.filter((p) => p.autocomplete !== 'current-password');
      // Some signup forms label their only password input current-password.
      // Accept that only when it is the sole visible password field.
      return fresh.length || fields.length !== 1 ? fresh : fields;
    }
    const current = fields.filter((p) => p.autocomplete === 'current-password');
    return current.length ? current : fields;
  };
  const byForm = new Map();
  for (const p of passwords) if (p.form) byForm.set(p.form, [...(byForm.get(p.form) || []), p]);
  const eligible = [...byForm.values()].flatMap(eligibleFor);
  const active = document.activeElement;
  const forms = [...new Set(eligible.map((p) => p.form))];
  let form = null;
  if (
    active instanceof HTMLInputElement &&
    active.type === 'password' &&
    active.form &&
    passwords.includes(active)
  )
    form = active.form;
  else if (forms.length === 1) form = forms[0];
  else if (forms.length > 1 && active && active !== document.body) {
    const owner = active.form || active.closest?.('form');
    if (owner && forms.includes(owner)) form = owner;
    else {
      const depth = (node) => {
        let d = 0;
        for (let n = node; n; n = n.parentNode) d++;
        return d;
      };
      const scored = forms.map((f) => {
        let n = f;
        while (n && !n.contains(active)) n = n.parentNode;
        return { f, d: n ? depth(n) : 0 };
      });
      const best = Math.max(...scored.map((x) => x.d));
      const winners = scored.filter((x) => x.d === best);
      if (winners.length === 1) form = winners[0].f;
    }
  }
  const set = (input, value) => {
    input.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertReplacementText',
        data: null,
      }),
    );
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  };
  const finish = (inputs, selectedPasswords, extra = {}) => {
    if (mode !== 'new-password') {
      const user =
        inputs.find((el) => el.autocomplete === 'username') ||
        inputs.find(
          (el) =>
            /^(user_?name|login|email)$/i.test(el.name) && ['text', 'email'].includes(el.type),
        );
      if (user) set(user, user.type === 'email' ? email || username : username);
      if (mode === 'signup' && email)
        for (const field of inputs.filter((el) => el.type === 'email' && el !== user))
          set(field, email);
    }
    if (typeof password !== 'string' || !password)
      return { ok: false, code: 'NO_PASSWORD_FROM_VAULT' };
    for (const field of selectedPasswords) set(field, password);
    // The value itself never leaves this function.
    if (!selectedPasswords.every((field) => field.isConnected && field.value === password))
      return { ok: false, code: 'PAGE_REJECTED_FILL' };
    return { ok: true, fields: selectedPasswords.length, ...extra };
  };
  // Password fields outside any <form> (some candidate portals). There is no
  // form destination to check, so this stays narrow: no visible password field
  // is inside a form, the field set is unambiguous, and the nearest container
  // has exactly one clear action control. Nothing is clicked or submitted.
  const fillFormless = () => {
    const loose = passwords.filter((p) => !p.form);
    if (!loose.length) return { ok: false, code: 'NO_SUPPORTED_FORM' };
    const chosen = eligibleFor(loose);
    if (
      !chosen.length ||
      chosen.length > 2 ||
      chosen.length !== loose.length ||
      (mode === 'login' && chosen.length !== 1)
    )
      return { ok: false, code: 'AMBIGUOUS_PASSWORD_FIELDS' };
    const shown = (el) => {
      if (el.hidden || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      if (el.getClientRects().length === 0) return false;
      const box = el.getBoundingClientRect();
      if (!(box.width > 0 && box.height > 0)) return false;
      if (el.closest('[hidden], [aria-hidden="true"], [inert], dialog:not([open])')) return false;
      for (let n = el; n; n = n.parentElement) {
        const st = getComputedStyle(n);
        if (
          st.display === 'none' ||
          st.visibility === 'hidden' ||
          Number.parseFloat(st.opacity) === 0
        )
          return false;
      }
      return true;
    };
    const label = (el) =>
      (el.getAttribute('aria-label') || el.value || el.textContent || '').trim();
    const isAction = (el) => {
      if (
        !el.matches(
          'button:not([type]), button[type="submit"], button[type="button"], input[type="submit"], input[type="button"], [role="button"]',
        )
      )
        return false;
      if (!shown(el) || el.hasAttribute('aria-pressed')) return false;
      if ((el.getAttribute('type') || '').toLowerCase() === 'reset') return false;
      const name = label(el);
      if (!name || /\b(show|hide|toggle|reveal|view)\b|visibility/i.test(name)) return false;
      const href = el.getAttribute('href');
      if (href != null) {
        try {
          if (new URL(href, document.baseURI).origin !== origin) return false;
        } catch {
          return false;
        }
      }
      return true;
    };
    let box = chosen[0].parentElement;
    while (box && !chosen.every((p) => box.contains(p))) box = box.parentElement;
    for (let depth = 0; box && depth < 8; box = box.parentElement, depth++) {
      if (box === document.body || box === document.documentElement || box.querySelector('form'))
        break;
      const actions = [...box.querySelectorAll('*')].filter(isAction);
      if (actions.length === 0) continue;
      if (actions.length !== 1) break;
      return finish(
        [...box.querySelectorAll('input')].filter((el) => !el.form && visible(el)),
        chosen,
        { formless: true },
      );
    }
    return { ok: false, code: 'FORMLESS_NO_CLEAR_SUBMIT' };
  };
  if (!passwords.some((p) => p.form)) return fillFormless();
  if (!form) return { ok: false, code: 'AMBIGUOUS_PASSWORD_FIELDS' };
  const implicitDestination = !form.hasAttribute('method') && !form.hasAttribute('action');
  const safeAction = (value) => {
    try {
      const url = new URL(value || location.href, document.baseURI);
      return url.origin === origin && url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  const safeTarget = (value) =>
    (
      value ||
      document.querySelector('base[target]')?.getAttribute('target') ||
      '_self'
    ).toLowerCase() === '_self';
  if (
    (!implicitDestination && form.getAttribute('method')?.toLowerCase() !== 'post') ||
    !safeAction(form.getAttribute('action')) ||
    !safeTarget(form.getAttribute('target'))
  )
    return { ok: false, code: 'UNSAFE_FORM_DESTINATION' };
  const controls = [...form.elements];
  const submitters = [
    ...controls.filter((el) => el.type === 'submit'),
    ...[...document.querySelectorAll('input[type="image"]')].filter((el) => el.form === form),
  ];
  for (const button of submitters) {
    if (
      (button.hasAttribute('formaction') && !safeAction(button.getAttribute('formaction'))) ||
      (button.hasAttribute('formmethod') &&
        button.getAttribute('formmethod')?.toLowerCase() !== 'post') ||
      (button.hasAttribute('formtarget') && !safeTarget(button.getAttribute('formtarget')))
    )
      return { ok: false, code: 'UNSAFE_FORM_DESTINATION' };
  }
  const inForm = eligibleFor(byForm.get(form) || []);
  const selectedPasswords =
    mode === 'login' ? (inForm.length === 1 ? inForm : inForm.filter((p) => p === active)) : inForm;
  if (!selectedPasswords.length || selectedPasswords.length > 2)
    return { ok: false, code: 'AMBIGUOUS_PASSWORD_FIELDS' };
  if (implicitDestination) {
    const guardKey = Symbol.for('mail-hq.vault.guarded-forms');
    if (!window[guardKey]) {
      const guarded = new WeakSet();
      window[guardKey] = guarded;
      window.addEventListener('submit', (event) => {
        if (!guarded.has(event.target)) return;
        const method =
          event.submitter?.getAttribute('formmethod') ??
          event.target.getAttribute('method') ??
          'get';
        if (method.toLowerCase() !== 'post') event.preventDefault();
      });
    }
    window[guardKey].add(form);
  }
  return finish(
    controls.filter((el) => el instanceof HTMLInputElement && visible(el)),
    selectedPasswords,
  );
}

/** Choose the one frame to fill from executeScript allFrames probe results.
 * Only frames whose own probe passed the origin checks are candidates. */
export function pickFillFrame(probes) {
  const usable = (probes || []).filter(
    (r) => r?.result?.ok && r.result.probe && r.result.count > 0,
  );
  if (usable.length > 1) return { ok: false, code: 'MULTIPLE_PASSWORD_FRAMES' };
  if (usable.length === 1)
    return { ok: true, frameId: usable[0].frameId, documentId: usable[0].documentId };
  return { ok: false, code: 'NO_SUPPORTED_FORM' };
}
