import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASSWORD_LENGTH,
  LEGACY_ALPHABET,
  LEGACY_SYMBOLS,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PasswordPolicyError,
  canonicalPasswordPolicy,
  defaultPasswordPolicy,
  generateVaultPassword,
  openVaultPassword,
  passwordPolicyInput,
  passwordSatisfiesPolicy,
  redactVaultResult,
  resolvePasswordPolicy,
  upsertPasswordPolicy,
  vaultPasswordPolicyField,
} from '../worker/src/vault/password';

const SAP = { minLength: 8, maxLength: 25, require: ['upper', 'lower', 'digit'] as const };
const serviceId = '11111111-1111-4111-8111-111111111111';

function sealed(password: string) {
  return `sealed:${password.length}`;
}

describe('vault password policy', () => {
  it('keeps the historical password when no policy is given', () => {
    const { policy, persist } = resolvePasswordPolicy(undefined, null);
    expect(persist).toBe(false);
    expect(policy).toEqual(defaultPasswordPolicy());
    expect(policy.length).toBe(DEFAULT_PASSWORD_LENGTH);
    expect(policy.require).toEqual(['digit', 'lower', 'symbol', 'upper']);
    expect(new Set(policy.symbols)).toEqual(new Set(LEGACY_SYMBOLS));
    const opened = openVaultPassword({
      service: { password_length: 32 },
      encrypt: (password) => {
        expect(password).toHaveLength(32);
        expect([...password].every((char) => LEGACY_ALPHABET.includes(char))).toBe(true);
        expect(password).toMatch(/[A-Z]/);
        expect(password).toMatch(/[a-z]/);
        expect(password).toMatch(/[0-9]/);
        expect([...password].some((char) => LEGACY_SYMBOLS.includes(char))).toBe(true);
        expect(password).not.toMatch(/[IOl01\s]/);
        return sealed(password);
      },
    });
    expect(opened.persist).toBe(false);
    expect(opened.legacyPasswordLength).toBe(32);
    expect(opened.ciphertext).toBe('sealed:32');
    expect(JSON.stringify(opened)).not.toMatch(/[A-Za-z0-9!@#$%_-]{32}/);
  });

  it('uses a service password_length and a stored policy on later rotations', () => {
    expect(resolvePasswordPolicy(undefined, { password_length: 24 }).policy.length).toBe(24);
    expect(resolvePasswordPolicy(undefined, { password_length: 10 }).policy.length).toBe(32);
    const first = resolvePasswordPolicy(SAP, { password_length: 32 });
    expect(first.persist).toBe(true);
    expect(first.policy.length).toBe(25);
    expect(first.policy.minLength).toBe(PASSWORD_MIN);
    expect(first.policy.maxLength).toBe(25);
    expect(first.policy.require).not.toContain('symbol');
    const stored = canonicalPasswordPolicy(first.policy);
    const again = resolvePasswordPolicy(undefined, {
      password_length: 32,
      password_policy: stored,
    });
    expect(again.persist).toBe(false);
    expect(again.policy.length).toBe(25);
    expect(again.policy.maxLength).toBe(25);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const password = generateVaultPassword(again.policy);
      expect(passwordSatisfiesPolicy(password, again.policy)).toBe(true);
      expect(password).toHaveLength(25);
      expect(password).not.toMatch(/\s/);
      seen.add(password);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('rejects policies that cannot be satisfied and never echoes them as a password', () => {
    const bad = [
      { minLength: 7 },
      { maxLength: 65 },
      { minLength: 20, maxLength: 10 },
      { minLength: 8.5 },
      { maxLength: 25, require: ['upper', 'lower', 'digit', 'symbol', 'upper'] },
      { minLength: 8, maxLength: 8, require: ['upper', 'lower', 'digit', 'symbol', 'digit'] },
      { symbols: ' ', require: ['upper'] },
      { symbols: 'a', require: ['upper'] },
      { symbols: '!!', require: ['symbol'] },
      { symbols: '', require: ['symbol'] },
      { minLength: 8, maxLength: 3, require: ['upper', 'lower', 'digit', 'symbol'] },
      { extra: true },
    ];
    for (const policy of bad) {
      expect(() => resolvePasswordPolicy(policy)).toThrow(PasswordPolicyError);
      try {
        resolvePasswordPolicy(policy);
      } catch (error) {
        expect(error).toBeInstanceOf(PasswordPolicyError);
        expect((error as PasswordPolicyError).code).toBe('INVALID_PASSWORD_POLICY');
        expect((error as Error).message).not.toMatch(/sealed|password=/i);
      }
    }
    expect(
      passwordPolicyInput.safeParse({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX }).success,
    ).toBe(true);
    expect(vaultPasswordPolicyField.passwordPolicy.safeParse(undefined).success).toBe(true);
    expect(vaultPasswordPolicyField.passwordPolicy.safeParse(SAP).success).toBe(true);
  });

  it('refuses to return a password from the credential helper and strips secret fields', () => {
    let captured = '';
    const opened = openVaultPassword({
      passwordPolicy: {
        minLength: 8,
        maxLength: 12,
        symbols: '@',
        require: ['upper', 'lower', 'digit', 'symbol'],
      },
      encrypt: (password) => {
        captured = password;
        return sealed(password);
      },
    });
    expect(captured).toHaveLength(12);
    expect(passwordSatisfiesPolicy(captured, opened.policy)).toBe(true);
    expect([...captured].filter((char) => char === '@').length).toBeGreaterThan(0);
    expect(opened.legacyPasswordLength).toBeNull();
    expect(JSON.stringify(opened)).not.toContain(captured);
    const pub = redactVaultResult({
      status: 'stored',
      accountId: serviceId,
      password: captured,
      nested: { ciphertext: 'secret', username: 'ada' },
    });
    expect(pub).toEqual({ status: 'stored', accountId: serviceId, nested: { username: 'ada' } });
    expect(JSON.stringify(pub)).not.toContain(captured);
    expect(() => openVaultPassword({ encrypt: (password) => password })).toThrow(
      /Encryption failed/,
    );
  });

  it('stores a per-service policy without putting the password in the row', () => {
    const { policy } = resolvePasswordPolicy(SAP);
    const write = upsertPasswordPolicy(serviceId, policy);
    expect(write.params[1]).not.toMatch(/\s/);
    expect(write.params[1]).not.toContain('password');
    const sql = new DatabaseSync(':memory:');
    sql.exec(readFileSync('migrations/0013_vault_password_policy.sql', 'utf8'));
    sql.prepare(write.sql).run(...write.params);
    const row = sql
      .prepare('SELECT policy FROM vault_password_policies WHERE service_id=?')
      .get(serviceId) as {
      policy: string;
    };
    expect(resolvePasswordPolicy(undefined, { password_policy: row.policy }).policy).toEqual(
      policy,
    );
    expect(() => upsertPasswordPolicy('not-a-uuid', policy)).toThrow(PasswordPolicyError);
    sql.close();
  });

  it('gives different policies different idempotency fingerprints', () => {
    const a = canonicalPasswordPolicy(resolvePasswordPolicy(SAP).policy);
    const b = canonicalPasswordPolicy(resolvePasswordPolicy({ ...SAP, maxLength: 24 }).policy);
    const c = canonicalPasswordPolicy(
      resolvePasswordPolicy({ maxLength: 25, minLength: 8, symbols: '@!' }).policy,
    );
    const d = canonicalPasswordPolicy(
      resolvePasswordPolicy({ maxLength: 25, minLength: 8, symbols: '!@' }).policy,
    );
    expect(a).not.toBe(b);
    expect(c).toBe(d);
  });
});
