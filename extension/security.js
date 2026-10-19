/** Runs in Chrome's isolated world, top frame only. Never returns field values. */
export function fillForm({ origin, username, password, email, mode = 'login' }) {
  if (window.top !== window || location.origin !== origin || location.protocol !== 'https:')
    return { ok: false, code: 'ORIGIN_MISMATCH' };
  const visible = (input) =>
    !input.disabled && !input.readOnly && input.getClientRects().length > 0;
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
  const first = passwords.find((p) =>
    mode === 'new-password' ? p.autocomplete === 'new-password' : true,
  );
  if (!first?.form) return { ok: false, code: 'NO_SUPPORTED_FORM' };
  const form = first.form;
  // React/SPA forms often omit both attributes and submit through JavaScript.
  // An explicit method (including empty/invalid values) must still be POST.
  const implicitDestination = !form.hasAttribute('method') && !form.hasAttribute('action');
  const safeAction = (value) => {
    try {
      const url = new URL(value || location.href, document.baseURI);
      return (
        url.origin === origin && url.protocol === 'https:' && !url.username && !url.password
      );
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
  // form.elements excludes image submitters; include these and external controls.
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
  const set = (input, value) => {
    // Use the native setter so React's value tracker sees the input event.
    // Real focus/blur also triggers validators that commit on leaving a field.
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
  const selectedPasswords =
    mode === 'login'
      ? [first]
      : passwords.filter(
          (p) =>
            p.form === form &&
            (mode === 'new-password'
              ? p.autocomplete === 'new-password'
              : p.autocomplete !== 'current-password'),
        );
  if (!selectedPasswords.length || selectedPasswords.length > 2)
    return { ok: false, code: 'AMBIGUOUS_PASSWORD_FIELDS' };
  if (implicitDestination) {
    // Missing attributes also mean native GET. Let the site's submit handlers
    // run, but prevent that fallback from putting credentials in a URL if the
    // handler is absent/broken. Keep only weak form references in the isolated
    // world; no credential values or page-visible markers are stored here.
    const guardKey = Symbol.for('mail-hq.vault.guarded-forms');
    if (!window[guardKey]) {
      const forms = new WeakSet();
      window[guardKey] = forms;
      window.addEventListener('submit', (event) => {
        if (!forms.has(event.target)) return;
        const method =
          event.submitter?.getAttribute('formmethod') ??
          event.target.getAttribute('method') ??
          'get';
        if (method.toLowerCase() !== 'post') event.preventDefault();
      });
    }
    window[guardKey].add(form);
  }
  const inputs = controls.filter((el) => el instanceof HTMLInputElement && visible(el));
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
  for (const field of selectedPasswords) set(field, password);
  return { ok: true, fields: selectedPasswords.length };
}
