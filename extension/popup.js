const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);
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
  await run(async () => {
    const data = await send({ action: 'load' });
    if (data.error) throw new Error(data.error);
    $('pair').hidden = data.paired;
    $('vault').hidden = !data.paired;
    if (!data.paired) {
      status(
        data.fingerprint
          ? `Awaiting approval. Fingerprint: ${data.fingerprint}`
          : 'Pair your extension to begin.',
      );
      return;
    }
    status('Connected');
    $('origin').textContent = data.origin;
    $('automatic').checked = !!data.auto;
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
    if (!data.accounts.length)
      status('No credentials for this website. Create one in Mail HQ or through MCP.');
  });
}
$('connect').addEventListener('click', () =>
  run(async () => {
    const server = new URL($('server').value).origin;
    if (!server.startsWith('https://')) throw new Error('USE_HTTPS_SERVER_ORIGIN');
    if (!(await chrome.permissions.request({ origins: [`${server}/*`] })))
      throw new Error('PERMISSION_REQUIRED');
    const result = await send({ action: 'pair', server });
    if (result.error) throw new Error(result.error);
    status(`Confirm fingerprint ${result.fingerprint} in Mail HQ.`);
  }),
);
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
