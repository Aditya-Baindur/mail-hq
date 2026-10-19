import { fillForm } from './security.js';
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(',')}}`
      : JSON.stringify(value);
const base64 = (bytes) => btoa(String.fromCharCode(...bytes));
let busy = false;
async function database() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('agent-vault', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new Error('KEY_STORAGE_FAILED'));
  });
}
async function signingKey(reset = false) {
  const db = await database();
  try {
    const stored = await new Promise((resolve, reject) => {
      const r = db.transaction('keys').objectStore('keys').get('identity');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error('KEY_STORAGE_FAILED'));
    });
    if (stored && !reset) return stored;
    // Private key is non-extractable and lives in extension IndexedDB. The
    // public key remains exportable for server-side verification.
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      tx.objectStore('keys').put(key, 'identity');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(new Error('KEY_STORAGE_FAILED'));
    });
    return key;
  } finally {
    db.close();
  }
}
async function config() {
  return chrome.storage.local.get(['server', 'pairingId', 'fingerprint', 'autoOrigins']);
}
async function rpc(action, parameters = {}) {
  const cfg = await config();
  if (!cfg.server || !cfg.pairingId) throw new Error('PAIR_EXTENSION_FIRST');
  const message = {
    pairingId: cfg.pairingId,
    nonce: crypto.randomUUID(),
    time: Date.now(),
    action,
    ...parameters,
  };
  const signature = base64(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        (await signingKey()).privateKey,
        new TextEncoder().encode(canonical(message)),
      ),
    ),
  );
  const response = await fetch(`${cfg.server}/vault/extension`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...message, signature }),
    redirect: 'error',
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('VAULT_ACCESS_DENIED');
  return response.json();
}
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url || !tab.url.startsWith('https://'))
    throw new Error('OPEN_HTTPS_WEBSITE');
  return { ...tab, origin: new URL(tab.url).origin };
}
async function fill(accountId, mode = 'login', requestId) {
  const tab = await activeTab();
  const credential = await rpc('fill', {
    origin: tab.origin,
    accountId,
    ...(requestId ? { requestId } : {}),
    candidate: mode === 'new-password' ? 'pending' : 'current',
  });
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'ISOLATED',
      func: fillForm,
      args: [{ origin: tab.origin, ...credential, mode }],
    });
    const result = results[0]?.result;
    if (!result?.ok) throw new Error(result?.code || 'FILL_FAILED');
    return { ok: true };
  } finally {
    credential.password = '';
  }
}
async function autoFill() {
  if (busy) return;
  busy = true;
  try {
    const cfg = await config(),
      tab = await activeTab();
    if (!cfg.autoOrigins?.includes(tab.origin)) return;
    const { requests } = await rpc('requests', { origin: tab.origin });
    // Multiple competing requests require the popup to choose an account.
    if (requests.length === 1) await fill(requests[0].accountId, requests[0].mode, requests[0].id);
  } catch {
    /* Never log credentials, page content or fetch errors. */
  } finally {
    busy = false;
  }
}
chrome.alarms.create('vault-fill', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'vault-fill') void autoFill();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')))
    return false;
  (async () => {
    if (message.action === 'pair') {
      const url = new URL(message.server);
      if (url.protocol !== 'https:' || url.origin !== message.server)
        throw new Error('USE_HTTPS_SERVER_ORIGIN');
      const key = await signingKey(true),
        publicKey = await crypto.subtle.exportKey('jwk', key.publicKey);
      const response = await fetch(`${url.origin}/vault/extension/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey }),
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('PAIRING_FAILED');
      const result = await response.json();
      if (!/^https:\/\//.test(result.authorizeUrl)) throw new Error('PAIRING_FAILED');
      await chrome.storage.local.set({
        server: url.origin,
        pairingId: result.pairingId,
        fingerprint: result.fingerprint,
        autoOrigins: [],
      });
      await chrome.tabs.create({ url: result.authorizeUrl });
      return { ok: true, fingerprint: result.fingerprint };
    }
    if (message.action === 'load') {
      const cfg = await config();
      if (!cfg.pairingId) return { paired: false };
      const status = await rpc('status');
      if (!status.paired) return { paired: false, fingerprint: cfg.fingerprint };
      const tab = await activeTab();
      const [accounts, requests] = await Promise.all([
        rpc('accounts', { origin: tab.origin }),
        rpc('requests', { origin: tab.origin }),
      ]);
      return {
        paired: true,
        origin: tab.origin,
        auto: cfg.autoOrigins?.includes(tab.origin),
        ...accounts,
        ...requests,
      };
    }
    if (message.action === 'fill') return fill(message.accountId, message.mode, message.requestId);
    if (message.action === 'automatic') {
      const tab = await activeTab(),
        cfg = await config(),
        origins = new Set(cfg.autoOrigins || []);
      message.enabled ? origins.add(tab.origin) : origins.delete(tab.origin);
      await chrome.storage.local.set({ autoOrigins: [...origins] });
      return { ok: true };
    }
    throw new Error('INVALID_REQUEST');
  })()
    .then(respond)
    .catch((e) => respond({ error: /^[A-Z_]+$/.test(e.message) ? e.message : 'EXTENSION_ERROR' }));
  return true;
});
