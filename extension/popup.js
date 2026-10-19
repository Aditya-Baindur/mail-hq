const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);
let waiting = false,
  loading = false,
  connecting = false;
function status(text) {
  $('status').textContent = text;
}
async function run(fn) {
  try {
    const result = await fn();
    if (result?.error) throw new Error(result.error);
    return result;
  } catch (e) {
    status(e.message);
    return null;
  }
}
async function load() {
  if (loading) return;
  loading = true;
  await run(async () => {
    const data = await send({ action: 'load' });
    if (data.error) throw new Error(data.error);
    $('pair').hidden = data.paired;
    $('vault').hidden = !data.paired;
    waiting = !data.paired && data.state === 'pending' && !!data.ownerEmail;
    $('connect').disabled = waiting || connecting;
    for (const [id, value] of [
      ['server', data.server],
      ['owner-email', data.ownerEmail],
      ['device-name', data.deviceName],
    ])
      if (value && !$(id).value) $(id).value = value;
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
      return;
    }
    status('Connected');
    $('origin').textContent = data.origin || 'Open an HTTPS website to use autofill.';
    $('automatic').checked = !!data.auto;
    $('automatic').disabled = !data.origin || !!data.siteDenied;
    $('all-websites').hidden = !data.allWebsites && !data.autoAll;
    $('automatic-all').checked = !!data.autoAll;
    $('accounts').replaceChildren();
    for (const account of data.accounts) {
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
            const ticket = data.requests.find(
              (r) => r.accountId === account.id && r.mode === mode,
            );
            const result = await send({
              action: 'fill',
              accountId: account.id,
              mode,
              ...(ticket ? { requestId: ticket.id } : {}),
            });
            if (result.error) throw new Error(result.error);
            status('Filled. Review the form before continuing.');
          }),
        );
        card.append(button);
      }
      $('accounts').append(card);
    }
    if (data.needsWebsite)
      status('Approved and connected. Open an HTTPS website to use autofill.');
    else if (data.siteDenied)
      status('Connected. This website is blocked or has not been approved.');
    else if (!data.accounts.length)
      status('No credentials for this website. Create one in Mail HQ or through MCP.');
  });
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
    status(
      `Request sent. Approve it on your main computer. Fingerprint: ${result.fingerprint}`,
    );
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
