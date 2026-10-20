import { shouldAutoRetry, showPairingSetup } from './protocol.js';
const $ = (id) => document.getElementById(id);
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const send = async (message) => {
  const response = await chrome.runtime.sendMessage(message);
  if (response === undefined) throw new Error('NO_RESPONSE_FROM_EXTENSION');
  return response;
};
const describe = (code) =>
  ({
    AMBIGUOUS_PASSWORD_FIELDS:
      'More than one possible password field. Click the right password field on the page, then try again.',
    NO_SUPPORTED_FORM:
      'No visible password field on this page or its same-site frames. On email-first logins, continue to the password step and fill again.',
    MULTIPLE_PASSWORD_FRAMES:
      'Password fields are in more than one frame of this page, so nothing was filled.',
    CROSS_ORIGIN_FRAME: 'Blocked: the password field is in a frame from another site.',
    FRAME_TARGET_UNAVAILABLE: 'The page changed before the fill. Reload it and try again.',
    NO_PASSWORD_FROM_VAULT: 'The vault returned no password.',
    FORMLESS_NO_CLEAR_SUBMIT:
      'The password field is not in a form and has no single clear action nearby, so it was not filled.',
    UNSAFE_FORM_DESTINATION: 'Blocked: this form would send data off-site or by GET.',
    ORIGIN_MISMATCH: 'Blocked: the page changed origin. Reload and try again.',
    PAGE_REJECTED_FILL: 'The page cleared the filled value. Nothing was kept.',
    NO_FIELDS_FILLED: 'Nothing was filled.',
    VAULT_FILL_NOT_READY: 'The vault did not release a password (pending or awaiting approval).',
    VAULT_FILL_REFUSED: 'The vault refused the fill.',
    VAULT_ACCESS_DENIED: 'The vault refused the request.',
    VAULT_UNREACHABLE:
      'Vault unreachable. Your pairing is kept; retrying automatically (or press Refresh).',
    NO_RESPONSE_FROM_EXTENSION:
      'The extension is restarting. Retrying automatically (or press Refresh).',
    EXTENSION_ERROR: 'Temporary extension error. Retrying automatically (or press Refresh).',
    PAIRING_KEY_MISSING: 'This browser lost its pairing key. Request pairing again.',
    PAIRING_REVOKED_OR_EXPIRED: 'This browser is not paired. Request pairing again.',
    PAGE_SCRIPT_BLOCKED:
      'Chrome blocked access to this tab. Click the page, reopen this popup and retry.',
    OPEN_HTTPS_WEBSITE: 'Open the HTTPS website in the active tab first.',
  })[code] || code;
let waiting = false,
  loading = false,
  connecting = false,
  retryTimer = null,
  lastCode = '';
async function storedPairing() {
  try {
    const { pairingId } = await chrome.storage.local.get('pairingId');
    return !!pairingId;
  } catch {
    return true;
  }
}
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void load(), 10000);
}
function status(text) {
  $('status').textContent = text;
}
function applyFields(data) {
  for (const [id, value] of [
    ['server', data.server],
    ['owner-email', data.ownerEmail],
    ['device-name', data.deviceName],
  ])
    if (value && !$(id).value) $(id).value = value;
}
async function run(fn) {
  try {
    const result = await fn();
    if (result?.error) throw new Error(result.error);
    return result;
  } catch (e) {
    lastCode = CODE.test(e.message) ? e.message : 'EXTENSION_ERROR';
    console.warn('[agent-vault]', lastCode);
    status(`Error: ${describe(lastCode)} (${lastCode})`);
    return null;
  }
}
async function load() {
  if (loading) return;
  loading = true;
  const ok = await run(async () => {
    const data = await send({ action: 'load' });
    if (data.error) {
      applyFields(data);
      throw new Error(data.error);
    }
    const stored = await storedPairing();
    const showSetup = showPairingSetup({
      storedPairing: stored,
      paired: data.paired,
      state: data.state,
    });
    $('pair').hidden = !showSetup;
    $('vault').hidden = showSetup || !data.paired;
    waiting = showSetup && data.state === 'pending' && !!data.ownerEmail;
    $('connect').disabled = waiting || connecting;
    applyFields(data);
    if (!data.paired) {
      const decision =
        data.state === 'denied'
          ? 'Pairing denied. You can request again.'
          : data.state === 'expired'
            ? 'Pairing expired. Request again and approve within ten minutes.'
            : data.state === 'revoked'
              ? 'Pairing revoked. Request again if you need access.'
              : data.state === 'pending' && !data.ownerEmail
                ? 'Enter your Mail HQ email and request pairing again to show this browser in your dashboard inbox.'
                : data.fingerprint
                  ? `Waiting for approval on your main computer. Fingerprint: ${data.fingerprint}${data.expiresAt ? `. Expires ${new Date(data.expiresAt).toLocaleTimeString()}` : ''}`
                  : 'Request pairing, then approve it on your main computer.';
      status(decision);
      return true;
    }
    status('Connected');
    $('origin').textContent = data.origin || 'Open an HTTPS website to use autofill.';
    $('automatic').checked = !!data.auto;
    $('automatic').disabled = !data.origin || !!data.siteDenied;
    $('all-websites').hidden = !data.allWebsites && !data.autoAll;
    $('automatic-all').checked = !!data.autoAll;
    $('accounts').replaceChildren();
    for (const account of data.accounts || []) {
      const card = document.createElement('div');
      card.className = 'account';
      const title = document.createElement('strong'),
        user = document.createElement('small');
      title.textContent = account.label;
      user.textContent = account.username;
      card.append(title, user);
      for (const [mode, label] of [
        ['login', 'Fill login'],
        ['signup', 'Fill signup'],
        ...(account.hasPending ? [['new-password', 'Fill replacement']] : []),
      ]) {
        const button = document.createElement('button');
        button.textContent = label;
        button.addEventListener('click', () =>
          run(async () => {
            status(`Filling ${label.toLowerCase().replace('fill ', '')}…`);
            const ticket = (data.requests || []).find(
              (r) => r.accountId === account.id && r.mode === mode,
            );
            const result = await send({
              action: 'fill',
              accountId: account.id,
              mode,
              ...(ticket ? { requestId: ticket.id } : {}),
            });
            if (result.error) throw new Error(result.error);
            if (!result.ok || !(result.fields > 0)) throw new Error('NO_FIELDS_FILLED');
            status(
              `Filled ${result.fields} password field${result.fields > 1 ? 's' : ''}${result.formless ? ' (field is outside a form)' : ''}${result.frame === 'same-origin frame' ? ' in an embedded frame' : ''}. Review the form before continuing.`,
            );
          }),
        );
        card.append(button);
      }
      $('accounts').append(card);
    }
    if (data.needsWebsite) status('Approved and connected. Open an HTTPS website to use autofill.');
    else if (data.unreachable) status(`Connected, but ${describe('VAULT_UNREACHABLE')}`);
    else if (data.siteDenied)
      status('Connected. This website is blocked or has not been approved.');
    else if (!(data.accounts || []).length)
      status('No credentials for this website. Create one in Mail HQ or through MCP.');
    else if (
      data.lastFill &&
      data.lastFill.origin === data.origin &&
      Date.now() - data.lastFill.at < 600000
    )
      status(
        `Connected. Last fill (${data.lastFill.mode}, ${new Date(data.lastFill.at).toLocaleTimeString()}): ` +
          (data.lastFill.ok
            ? `filled ${data.lastFill.fields} field(s).`
            : `failed: ${describe(data.lastFill.code)} (${data.lastFill.code})`),
      );
    if (data.unreachable) scheduleRetry();
    return true;
  });
  if (!ok) {
    const stored = await storedPairing();
    const show = showPairingSetup({ storedPairing: stored, loadError: lastCode });
    $('pair').hidden = !show;
    if (show) $('vault').hidden = true;
    if (shouldAutoRetry(lastCode)) scheduleRetry();
  }
  loading = false;
}
$('connect').addEventListener('click', () => {
  if (connecting) return;
  connecting = true;
  $('connect').disabled = true;
  void run(async () => {
    if (!['server', 'owner-email', 'device-name'].every((id) => $(id).reportValidity())) return;
    const server = new URL($('server').value).origin;
    if (!server.startsWith('https://')) throw new Error('USE_HTTPS_SERVER_ORIGIN');
    if (!(await chrome.permissions.request({ origins: [`${server}/*`] })))
      throw new Error('PERMISSION_REQUIRED');
    const result = await send({
      action: 'pair',
      server,
      ownerEmail: $('owner-email').value,
      deviceName: $('device-name').value,
    });
    if (result.error) throw new Error(result.error);
    status(`Request sent. Approve it on your main computer. Fingerprint: ${result.fingerprint}`);
    waiting = true;
    $('connect').disabled = true;
    await load();
  }).finally(() => {
    connecting = false;
    $('connect').disabled = waiting;
  });
});
$('automatic').addEventListener('change', () =>
  run(async () => {
    if ($('automatic').checked) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const origin = new URL(tab.url).origin;
      if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
        $('automatic').checked = false;
        throw new Error('PERMISSION_REQUIRED');
      }
    }
    return send({ action: 'automatic', enabled: $('automatic').checked });
  }),
);
$('refresh').addEventListener('click', load);
$('automatic-all').addEventListener('change', () =>
  run(async () => {
    const enabled = $('automatic-all').checked;
    if (enabled && !(await chrome.permissions.request({ origins: ['https://*/*'] }))) {
      $('automatic-all').checked = false;
      throw new Error('PERMISSION_REQUIRED');
    }
    const result = await send({ action: 'automatic-all', enabled });
    if (result.error) {
      $('automatic-all').checked = false;
      throw new Error(result.error);
    }
    return result;
  }),
);
void load();
setInterval(() => {
  if (waiting) void load();
}, 5000);
