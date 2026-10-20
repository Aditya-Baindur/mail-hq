import { describe, expect, it } from 'vitest';
import {
  failureCodeFromResponse,
  shouldAutoRetry,
  showPairingSetup,
  signingKeyAction,
} from '../extension/protocol.js';

describe('extension pairing protocol', () => {
  it('does not surface arbitrary response text as an error code', () => {
    expect(failureCodeFromResponse(503, 'PAIRING_REVOKED_OR_EXPIRED')).toBe('VAULT_UNREACHABLE');
    expect(failureCodeFromResponse(429, 'nope')).toBe('VAULT_UNREACHABLE');
    expect(failureCodeFromResponse(408, undefined)).toBe('VAULT_UNREACHABLE');
    expect(failureCodeFromResponse(401, 'PAIRING_REVOKED_OR_EXPIRED')).toBe(
      'PAIRING_REVOKED_OR_EXPIRED',
    );
    expect(failureCodeFromResponse(400, 'SecretPassword1')).toBe('VAULT_ACCESS_DENIED');
    expect(failureCodeFromResponse(400, 'password')).toBe('VAULT_ACCESS_DENIED');
    expect(failureCodeFromResponse(400, 'HAS SPACE')).toBe('VAULT_ACCESS_DENIED');
  });

  it('shows setup only for an explicit unpaired state and mints a key only when pairing', () => {
    expect(showPairingSetup({ storedPairing: true, loadError: 'VAULT_UNREACHABLE' })).toBe(false);
    expect(showPairingSetup({ storedPairing: true, loadError: 'VAULT_ACCESS_DENIED' })).toBe(false);
    expect(showPairingSetup({ storedPairing: true, loadError: 'EXTENSION_ERROR' })).toBe(false);
    expect(showPairingSetup({ storedPairing: true, loadError: 'PAIRING_KEY_MISSING' })).toBe(true);
    expect(showPairingSetup({ storedPairing: true, loadError: 'PAIRING_REVOKED_OR_EXPIRED' })).toBe(
      true,
    );
    expect(showPairingSetup({ storedPairing: false, loadError: 'VAULT_UNREACHABLE' })).toBe(true);
    expect(showPairingSetup({ storedPairing: true, paired: true, state: 'approved' })).toBe(false);
    expect(showPairingSetup({ storedPairing: true, paired: false, state: 'revoked' })).toBe(true);
    expect(showPairingSetup({ storedPairing: true, paired: false, state: 'pending' })).toBe(true);
    expect(showPairingSetup({ storedPairing: true, paired: false, state: 'denied' })).toBe(true);
    expect(showPairingSetup({ storedPairing: true, paired: false, state: 'expired' })).toBe(true);
    expect(shouldAutoRetry('VAULT_UNREACHABLE')).toBe(true);
    expect(shouldAutoRetry('VAULT_ACCESS_DENIED')).toBe(false);
    expect(shouldAutoRetry('PAIRING_REVOKED_OR_EXPIRED')).toBe(false);
    expect(signingKeyAction({ hasKey: true, reset: false })).toBe('use');
    expect(signingKeyAction({ hasKey: false, reset: false })).toBe('missing');
    expect(signingKeyAction({ hasKey: false, reset: true })).toBe('mint');
    expect(signingKeyAction({ hasKey: true, reset: true })).toBe('mint');
  });
});
