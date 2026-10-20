import { fillForm, pickFillFrame } from './security.js';
import { failureCodeFromResponse, signingKeyAction } from './protocol.js';
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
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
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
    const action = signingKeyAction({ hasKey: !!stored, reset });
    if (action === 'use') return stored;
    // Only Request pairing (reset) may create a key. A normal call that finds
    // nothing must not mint a replacement and orphan the approved pairing.
    if (action !== 'mint') throw new Error('PAIRING_KEY_MISSING');
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
  return chrome.storage.local.get([
    'server',
    'pairingId',
    'fingerprint',
    'autoOrigins',
    'autoAll',
    'ownerEmail',
    'deviceName',
  ]);
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
  let response;
  try {
    response = await fetch(`${cfg.server}/vault/extension`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, signature }),
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('VAULT_UNREACHABLE');
  }
  if (!response.ok) {
    let bodyError;
    try {
      bodyError = (await response.json())?.error;
    } catch {
      bodyError = undefined;
    }
    throw new Error(failureCodeFromResponse(response.status, bodyError));
  }
  try {
    return await response.json();
  } catch {
    throw new Error('VAULT_UNREACHABLE');
  }
}
async function rpcRetry(action, parameters) {
  try {
    return await rpc(action, parameters);
  } catch (e) {
    if (e?.message !== 'VAULT_UNREACHABLE') throw e;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return rpc(action, parameters);
  }
}
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url || !tab.url.startsWith('https://'))
    throw new Error('OPEN_HTTPS_WEBSITE');
  return { ...tab, origin: new URL(tab.url).origin };
}
function codeOf(error, fallback) {
  return CODE.test(error?.message) ? error.message : fallback;
}
async function recordFill(entry) {
  const record = {
    ok: !!entry.ok,
    origin: typeof entry.origin === 'string' ? entry.origin : undefined,
    mode: entry.mode,
    source: entry.source,
    fields: entry.fields,
    formless: entry.formless || undefined,
    frame: entry.frame,
    code: entry.code,
    at: Date.now(),
  };
  (record.ok ? console.info : console.warn)('[agent-vault] fill', record);
  try {
    await chrome.storage.session.set({ lastFill: record });
  } catch {
    /* session storage unavailable; the popup still gets the direct response */
  }
}
async function fill(accountId, mode = 'login', requestId, source = 'popup') {
  let tab;
  let credential;
  try {
    tab = await activeTab();
    let probes;
    try {
      probes = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'ISOLATED',
        func: fillForm,
        args: [{ origin: tab.origin, mode, probe: true }],
      });
    } catch {
      throw new Error('PAGE_SCRIPT_BLOCKED');
    }
    const pick = pickFillFrame(probes);
    if (!pick.ok) throw new Error(pick.code);
    // A subframe without a document id could be reused after navigation.
    if (pick.frameId !== 0 && !pick.documentId) throw new Error('FRAME_TARGET_UNAVAILABLE');
    credential = await rpc('fill', {
      origin: tab.origin,
      accountId,
      ...(requestId ? { requestId } : {}),
      candidate: mode === 'new-password' ? 'pending' : 'current',
    });
    if (credential?.error)
      throw new Error(CODE.test(credential.error) ? credential.error : 'VAULT_FILL_REFUSED');
    if (typeof credential?.password !== 'string' || !credential.password)
      throw new Error('VAULT_FILL_NOT_READY');
    const username = typeof credential.username === 'string' ? credential.username : '';
    const email = typeof credential.email === 'string' ? credential.email : '';
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: pick.documentId
          ? { tabId: tab.id, documentIds: [pick.documentId] }
          : { tabId: tab.id, frameIds: [0] },
        world: 'ISOLATED',
        func: fillForm,
        args: [{ origin: tab.origin, username, email, password: credential.password, mode }],
      });
    } catch {
      throw new Error('PAGE_SCRIPT_BLOCKED');
    }
    const result = results?.[0]?.result;
    if (!result?.ok) throw new Error(result?.code || 'FILL_FAILED');
    if (!(result.fields > 0)) throw new Error('NO_FIELDS_FILLED');
    const frame = pick.frameId === 0 ? 'top' : 'same-origin frame';
    await recordFill({
      ok: true,
      origin: tab.origin,
      mode,
      source,
      fields: result.fields,
      formless: !!result.formless,
      frame,
    });
    return { ok: true, fields: result.fields, formless: !!result.formless, frame };
  } catch (e) {
    const code = codeOf(e, 'FILL_FAILED');
    await recordFill({ ok: false, origin: tab?.origin, mode, source, code });
    throw new Error(code);
  } finally {
    if (credential) credential.password = '';
  }
}
async function autoFill() {
  if (busy) return;
  busy = true;
  try {
    const cfg = await config(),
      tab = await activeTab();
    if (!cfg.autoAll && !cfg.autoOrigins?.includes(tab.origin)) return;
    if (!(await chrome.permissions.contains({ origins: [`${tab.origin}/*`] }))) return;
    const { requests } = await rpc('requests', { origin: tab.origin });
    if (requests.length === 1)
      await fill(requests[0].accountId, requests[0].mode, requests[0].id, 'automatic');
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
      const ownerEmail = String(message.ownerEmail || '')
        .trim()
        .toLowerCase();
      const deviceName = String(message.deviceName || 'Chrome extension').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) || ownerEmail.length > 254)
        throw new Error('ENTER_MAIL_HQ_EMAIL');
      if (!deviceName || deviceName.length > 80 || /[\u0000-\u001f\u007f]/.test(deviceName))
        throw new Error('ENTER_DEVICE_NAME');
      const key = await signingKey(true),
        publicKey = await crypto.subtle.exportKey('jwk', key.publicKey);
      const response = await fetch(`${url.origin}/vault/extension/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey, ownerEmail, deviceName }),
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
        autoAll: false,
        ownerEmail,
        deviceName,
      });
      return { ok: true, fingerprint: result.fingerprint, expiresAt: result.expiresAt };
    }
    if (message.action === 'load') {
      const cfg = await config();
      if (!cfg.pairingId) return { paired: false };
      let status;
      try {
        status = await rpcRetry('status');
      } catch (e) {
        const code = codeOf(e, 'EXTENSION_ERROR');
        console.warn('[agent-vault] status check failed', code);
        if (code === 'PAIRING_REVOKED_OR_EXPIRED')
          return {
            paired: false,
            state: 'revoked',
            server: cfg.server,
            ownerEmail: cfg.ownerEmail,
            deviceName: cfg.deviceName,
            fingerprint: cfg.fingerprint,
          };
        return {
          configured: true,
          error: code,
          server: cfg.server,
          ownerEmail: cfg.ownerEmail,
          deviceName: cfg.deviceName,
          fingerprint: cfg.fingerprint,
        };
      }
      const details = {
        paired: !!status.paired,
        state: status.state || (status.paired ? 'approved' : 'pending'),
        expiresAt: status.expiresAt,
        fingerprint: cfg.fingerprint,
        server: cfg.server,
        ownerEmail: cfg.ownerEmail,
        deviceName: cfg.deviceName,
        allWebsites: !!status.allWebsites,
        autoAll: !!cfg.autoAll,
        lastFill: (await chrome.storage.session.get('lastFill').catch(() => ({}))).lastFill,
      };
      if (!status.paired) return details;
      let tab;
      try {
        tab = await activeTab();
      } catch {
        return { ...details, origin: null, accounts: [], requests: [], needsWebsite: true };
      }
      try {
        const [accounts, requests] = await Promise.all([
          rpcRetry('accounts', { origin: tab.origin }),
          rpcRetry('requests', { origin: tab.origin }),
        ]);
        return {
          ...details,
          origin: tab.origin,
          auto: cfg.autoOrigins?.includes(tab.origin),
          ...accounts,
          ...requests,
        };
      } catch (e) {
        if (e?.message === 'VAULT_UNREACHABLE')
          return { ...details, origin: tab.origin, accounts: [], requests: [], unreachable: true };
        return { ...details, origin: tab.origin, accounts: [], requests: [], siteDenied: true };
      }
    }
    if (message.action === 'fill') {
      const mode = message.mode || 'login';
      if (!['login', 'signup', 'new-password'].includes(mode)) throw new Error('INVALID_REQUEST');
      return fill(message.accountId, mode, message.requestId);
    }
    if (message.action === 'automatic-all') {
      if (message.enabled) {
        const status = await rpc('status');
        if (!status.paired || !status.allWebsites)
          throw new Error('APPROVE_ALL_WEBSITES_IN_DASHBOARD');
        if (!(await chrome.permissions.contains({ origins: ['https://*/*'] })))
          throw new Error('PERMISSION_REQUIRED');
      }
      await chrome.storage.local.set({ autoAll: !!message.enabled });
      return { ok: true };
    }
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
    .catch((e) => respond({ error: codeOf(e, 'EXTENSION_ERROR') }));
  return true;
});
