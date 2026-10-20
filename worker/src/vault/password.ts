/**
 * Server-side passwords for vault_create_credential and vault_rotate_password.
 *
 * With no passwordPolicy, generation matches the historical vault password:
 * exactly the service's password_length (default 32), from the unambiguous
 * alphabet ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%_-,
 * and always containing an uppercase letter, a lowercase letter, a digit, and
 * a symbol. Passwords are handed only to the caller-supplied encrypt function
 * and are never returned.
 */
import { z } from 'zod';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;
export const DEFAULT_PASSWORD_LENGTH = 32;
/** Historical symbol set. Order is the generator's original alphabet order. */
export const LEGACY_SYMBOLS = '!@#$%_-';
export const LEGACY_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const LEGACY_LOWER = 'abcdefghijkmnopqrstuvwxyz';
export const LEGACY_DIGITS = '23456789';
export const LEGACY_ALPHABET = `${LEGACY_UPPER}${LEGACY_LOWER}${LEGACY_DIGITS}${LEGACY_SYMBOLS}`;
/** Symbols a policy may select. The default policy still uses LEGACY_SYMBOLS. */
export const SAFE_SYMBOLS = '!@#$%^&*_-+=.?';

const CLASSES = ['upper', 'lower', 'digit', 'symbol'] as const;
export type PasswordClass = (typeof CLASSES)[number];

export type ResolvedPasswordPolicy = {
  length: number;
  minLength: number;
  maxLength: number;
  symbols: string;
  require: PasswordClass[];
};

export type VaultServicePassword = {
  password_length?: number | null;
  password_policy?: string | null;
};

export class PasswordPolicyError extends Error {
  readonly code = 'INVALID_PASSWORD_POLICY';
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

export const passwordPolicyInput = z
  .object({
    minLength: z.number().int().min(PASSWORD_MIN).max(PASSWORD_MAX).optional(),
    maxLength: z.number().int().min(PASSWORD_MIN).max(PASSWORD_MAX).optional(),
    symbols: z.string().max(SAFE_SYMBOLS.length).optional(),
    require: z.array(z.enum(CLASSES)).max(CLASSES.length).optional(),
  })
  .strict();

export type PasswordPolicyInput = z.infer<typeof passwordPolicyInput>;

/** Optional field shared by vault_create_credential and vault_rotate_password. */
export const vaultPasswordPolicyField = {
  passwordPolicy: passwordPolicyInput
    .optional()
    .describe(
      'Site password rules. Omit to keep the historical 32-character (or per-service length) password. minLength/maxLength are 8–64. symbols, when set, replaces the default symbol set and may only use !@#$%^&*_-+=.?. require lists classes the password must include: upper, lower, digit, symbol.',
    ),
};

const SECRET_KEY = /^(password|ciphertext|pendingciphertext|pending_ciphertext|apicredential)$/i;

export function redactVaultResult<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactVaultResult(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = redactVaultResult(item);
    }
    return out as T;
  }
  return value;
}

export function canonicalPasswordPolicy(policy: ResolvedPasswordPolicy) {
  return JSON.stringify({
    length: policy.length,
    minLength: policy.minLength,
    maxLength: policy.maxLength,
    require: [...policy.require].sort(),
    symbols: [...policy.symbols].sort().join(''),
  });
}

export const PASSWORD_POLICY_SELECT =
  'SELECT policy FROM vault_password_policies WHERE service_id=?';

export function upsertPasswordPolicy(serviceId: string, policy: ResolvedPasswordPolicy) {
  if (!z.string().uuid().safeParse(serviceId).success)
    throw new PasswordPolicyError('Invalid service');
  return {
    sql: `INSERT INTO vault_password_policies(service_id, policy) VALUES(?, ?)
ON CONFLICT(service_id) DO UPDATE SET policy=excluded.policy, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    params: [serviceId, canonicalPasswordPolicy(policy)] as const,
  };
}

function parseInput(value: unknown): PasswordPolicyInput | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = passwordPolicyInput.safeParse(value);
  if (!parsed.success) throw new PasswordPolicyError('Password policy is invalid');
  return parsed.data;
}

function normalizeSymbols(symbols: string) {
  if ([...symbols].some((char) => /\s/u.test(char) || !SAFE_SYMBOLS.includes(char)))
    throw new PasswordPolicyError('Password policy symbols are not allowed');
  if (new Set(symbols).size !== symbols.length)
    throw new PasswordPolicyError('Password policy symbols are not allowed');
  return [...symbols].sort().join('');
}

function normalizeRequire(require: readonly string[]): PasswordClass[] {
  if (new Set(require).size !== require.length)
    throw new PasswordPolicyError('Password policy is invalid');
  return [...require].sort() as PasswordClass[];
}

function classPool(name: PasswordClass, symbols: string) {
  if (name === 'upper') return LEGACY_UPPER;
  if (name === 'lower') return LEGACY_LOWER;
  if (name === 'digit') return LEGACY_DIGITS;
  return symbols;
}

function assertGenerable(policy: ResolvedPasswordPolicy) {
  if (
    !Number.isInteger(policy.length) ||
    !Number.isInteger(policy.minLength) ||
    !Number.isInteger(policy.maxLength) ||
    policy.minLength < PASSWORD_MIN ||
    policy.maxLength > PASSWORD_MAX ||
    policy.minLength > policy.maxLength ||
    policy.length < policy.minLength ||
    policy.length > policy.maxLength
  )
    throw new PasswordPolicyError('Password policy is invalid');
  if (policy.require.includes('symbol') && policy.symbols.length === 0)
    throw new PasswordPolicyError('A symbol is required but no symbols are allowed');
  if (policy.length < policy.require.length)
    throw new PasswordPolicyError('Password length cannot satisfy the required character classes');
  if (policy.require.some((name) => classPool(name, policy.symbols).length === 0))
    throw new PasswordPolicyError('Password length cannot satisfy the required character classes');
}

function legacyPolicy(length: number): ResolvedPasswordPolicy {
  const policy: ResolvedPasswordPolicy = {
    length,
    minLength: length,
    maxLength: length,
    symbols: normalizeSymbols(LEGACY_SYMBOLS),
    require: normalizeRequire(CLASSES),
  };
  assertGenerable(policy);
  return policy;
}

export function defaultPasswordPolicy() {
  return legacyPolicy(DEFAULT_PASSWORD_LENGTH);
}

export function parseStoredPasswordPolicy(
  raw: string | null | undefined,
): ResolvedPasswordPolicy | null {
  if (raw == null || raw === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PasswordPolicyError('Stored password policy is invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PasswordPolicyError('Stored password policy is invalid');
  const record = value as Record<string, unknown>;
  const input = parseInput({
    minLength: record.minLength,
    maxLength: record.maxLength,
    symbols: record.symbols,
    require: record.require,
  });
  if (
    !input ||
    input.minLength == null ||
    input.maxLength == null ||
    !Array.isArray(record.require)
  )
    throw new PasswordPolicyError('Stored password policy is invalid');
  if (typeof record.symbols !== 'string')
    throw new PasswordPolicyError('Stored password policy is invalid');
  const length = record.length;
  if (typeof length !== 'number')
    throw new PasswordPolicyError('Stored password policy is invalid');
  const policy: ResolvedPasswordPolicy = {
    length,
    minLength: input.minLength,
    maxLength: input.maxLength,
    symbols: normalizeSymbols(input.symbols ?? ''),
    require: normalizeRequire(input.require ?? []),
  };
  try {
    assertGenerable(policy);
  } catch {
    throw new PasswordPolicyError('Stored password policy is invalid');
  }
  return policy;
}

function basePolicy(service?: VaultServicePassword | null) {
  const stored = parseStoredPasswordPolicy(service?.password_policy);
  if (stored) return stored;
  const length = service?.password_length;
  if (
    typeof length === 'number' &&
    Number.isInteger(length) &&
    length >= 20 &&
    length <= PASSWORD_MAX
  )
    return legacyPolicy(length);
  return defaultPasswordPolicy();
}

export function resolvePasswordPolicy(
  passwordPolicy: unknown,
  service?: VaultServicePassword | null,
) {
  const input = parseInput(passwordPolicy);
  const base = basePolicy(service);
  if (!input) return { policy: base, persist: false };
  let minLength = input.minLength ?? base.minLength;
  let maxLength = input.maxLength ?? base.maxLength;
  // A max-only override (SAP allows at most 25) shrinks a fixed historical length.
  if (input.maxLength != null && input.minLength == null && maxLength < minLength)
    minLength = PASSWORD_MIN;
  if (input.minLength != null && input.maxLength == null && minLength > maxLength)
    maxLength = PASSWORD_MAX;
  if (minLength > maxLength) throw new PasswordPolicyError('minLength cannot exceed maxLength');
  const symbols = input.symbols != null ? normalizeSymbols(input.symbols) : base.symbols;
  const require = input.require != null ? normalizeRequire(input.require) : base.require;
  const policy: ResolvedPasswordPolicy = {
    length: Math.min(maxLength, Math.max(minLength, base.length)),
    minLength,
    maxLength,
    symbols,
    require,
  };
  assertGenerable(policy);
  return { policy, persist: true };
}

function randomIndex(size: number) {
  const limit = Math.floor(256 / size) * size;
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % size;
  }
}

function pick(pool: string) {
  return pool[randomIndex(pool.length)];
}

function alphabet(policy: ResolvedPasswordPolicy) {
  return [...new Set(`${LEGACY_UPPER}${LEGACY_LOWER}${LEGACY_DIGITS}${policy.symbols}`)].join('');
}

export function passwordSatisfiesPolicy(password: string, policy: ResolvedPasswordPolicy) {
  if (password.length !== policy.length) return false;
  if ([...password].some((char) => !alphabet(policy).includes(char) || /\s/u.test(char)))
    return false;
  for (const name of policy.require) {
    const pool = classPool(name, policy.symbols);
    if (![...password].some((char) => pool.includes(char))) return false;
  }
  return true;
}

export function generateVaultPassword(policy: ResolvedPasswordPolicy) {
  assertGenerable(policy);
  const chars = Array<string>(policy.length).fill('');
  const positions = [...chars.keys()];
  for (let i = positions.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  policy.require.forEach((name, index) => {
    chars[positions[index]] = pick(classPool(name, policy.symbols));
  });
  const pool = alphabet(policy);
  for (let i = 0; i < chars.length; i++) if (!chars[i]) chars[i] = pick(pool);
  const password = chars.join('');
  if (!passwordSatisfiesPolicy(password, policy))
    throw new PasswordPolicyError('Generator failed to satisfy the policy');
  return password;
}

/**
 * Create or rotate a credential password. The password exists only inside this
 * function; encrypt must persist it and must not echo it back to MCP.
 */
export function openVaultPassword(options: {
  passwordPolicy?: unknown;
  service?: VaultServicePassword | null;
  encrypt: (password: string) => string;
}) {
  const { policy, persist } = resolvePasswordPolicy(options.passwordPolicy, options.service);
  const password = generateVaultPassword(policy);
  const ciphertext = options.encrypt(password);
  if (typeof ciphertext !== 'string' || ciphertext.length === 0 || ciphertext === password)
    throw new PasswordPolicyError('Encryption failed');
  return {
    ciphertext,
    policy,
    persist,
    legacyPasswordLength:
      policy.length >= 20 && policy.length <= PASSWORD_MAX ? policy.length : null,
  };
}
