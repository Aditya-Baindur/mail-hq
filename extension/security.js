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
  const safeAction = (value) => {
    try {
      const url = new URL(value || location.href, location.href);
      return url.origin === origin && url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  if (
    form.method.toLowerCase() !== 'post' ||
    !safeAction(form.action) ||
    (form.target && !['_self', ''].includes(form.target))
  )
    return { ok: false, code: 'UNSAFE_FORM_DESTINATION' };
  const controls = [...form.elements];
  for (const button of controls.filter((el) => ['submit', 'image'].includes(el.type))) {
    if (
      (button.hasAttribute('formaction') && !safeAction(button.getAttribute('formaction'))) ||
      (button.hasAttribute('formmethod') &&
        button.getAttribute('formmethod')?.toLowerCase() !== 'post') ||
      (button.hasAttribute('formtarget') && button.getAttribute('formtarget') !== '_self')
    )
      return { ok: false, code: 'UNSAFE_FORM_DESTINATION' };
  }
  const set = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
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
  const inputs = controls.filter((el) => el instanceof HTMLInputElement && visible(el));
  if (mode !== 'new-password') {
    const user =
      inputs.find((el) => el.autocomplete === 'username') ||
      inputs.find(
        (el) => /^(user_?name|login|email)$/i.test(el.name) && ['text', 'email'].includes(el.type),
      );
    if (user) set(user, user.type === 'email' ? email || username : username);
    if (mode === 'signup' && email)
      for (const field of inputs.filter((el) => el.type === 'email' && el !== user))
        set(field, email);
  }
  for (const field of selectedPasswords) set(field, password);
  return { ok: true, fields: selectedPasswords.length };
}
