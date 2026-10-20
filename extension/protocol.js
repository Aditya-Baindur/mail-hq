const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Map a vault HTTP failure to a stable code. Response bodies are not shown. */
export function failureCodeFromResponse(status, bodyError) {
  if (status === 408 || status === 429 || status >= 500) return 'VAULT_UNREACHABLE';
  if (typeof bodyError === 'string' && CODE.test(bodyError)) return bodyError;
  return 'VAULT_ACCESS_DENIED';
}

export function shouldAutoRetry(code) {
  return (
    code === 'VAULT_UNREACHABLE' ||
    code === 'NO_RESPONSE_FROM_EXTENSION' ||
    code === 'EXTENSION_ERROR'
  );
}

/**
 * The pairing form is for a browser that has no pairing, lost its key, or
 * received an explicit not-paired/revoked/denied/expired/pending answer.
 * Transient vault and service-worker errors keep the stored pairing.
 */
export function showPairingSetup({ storedPairing, paired, state, loadError }) {
  if (loadError === 'PAIRING_KEY_MISSING' || loadError === 'PAIRING_REVOKED_OR_EXPIRED')
    return true;
  if (loadError) return !storedPairing;
  if (paired === true) return false;
  if (!storedPairing) return true;
  if (paired === false && ['revoked', 'denied', 'expired', 'pending'].includes(state)) return true;
  if (paired === false && !state) return true;
  return false;
}

/** A new identity key is minted only for an explicit pairing request. */
export function signingKeyAction({ hasKey, reset }) {
  if (hasKey && reset !== true) return 'use';
  if (reset === true) return 'mint';
  return 'missing';
}
