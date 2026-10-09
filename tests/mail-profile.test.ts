import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeSettings, createMailPassword } from '../worker/src/bridge';
import { fetchApi } from '../worker/src/index';
import { boxA, setup } from './helpers';

let f: ReturnType<typeof setup>, login: Awaited<ReturnType<typeof createMailPassword>>;
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
beforeEach(async () => {
  f = setup(); f.env.BRIDGE_HOST = 'bridge.example.com'; f.env.BRIDGE_API_SECRET = 'private-bridge-secret'; f.env.BRIDGE_SMTP_PORT = '443';
  login = await createMailPassword(f.env, 'test', { mailboxId: boxA, name: 'iPhone' });
});
afterEach(() => f.close());
const download = () => fetchApi(new Request(`http://localhost/api/mail-apps/${login.id}/apple.mobileconfig`), f.env, ctx);

describe('Apple Mail setup download', () => {
  it('requires dashboard authentication and never exposes credentials in the profile', async () => {
    const denied = await fetchApi(new Request(`https://mail.example.com/api/mail-apps/${login.id}/apple.mobileconfig`), f.env, ctx);
    expect(denied?.status).toBe(401);
    f.sql.prepare('UPDATE mailboxes SET name=? WHERE id=?').run('A & B </string><key>Injected</key>', boxA);
    const response = await download();
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe('application/x-apple-aspen-config');
    expect(response?.headers.get('cache-control')).toBe('no-store');
    const profile = await response!.text();
    expect(profile).toContain('A &amp; B &lt;/string&gt;&lt;key&gt;Injected&lt;/key&gt;');
    expect(profile).not.toContain(login.password);
    expect(profile).not.toContain(f.env.BRIDGE_API_SECRET);
    expect(profile).not.toContain('<key>IncomingPassword</key>');
    expect(profile).not.toContain('<key>OutgoingPassword</key>');
    expect(profile).toContain('<key>IncomingMailServerPortNumber</key><integer>993</integer>');
    expect(profile).toContain('<key>OutgoingMailServerPortNumber</key><integer>443</integer>');
    expect(profile).toContain('<key>IncomingMailServerUseSSL</key><true/>');
    expect(profile).toContain('<key>OutgoingMailServerUseSSL</key><true/>');
    expect(profile).toContain('<key>OutgoingPasswordSameAsIncomingPassword</key><true/>');
    expect(profile.match(/<string>com\.apple\./g)).toHaveLength(1);
    expect(login.smtpPort).toBe(443);
  });
  it('does not offer profiles for revoked credentials or paused mailboxes', async () => {
    f.sql.prepare("UPDATE mailboxes SET status='paused' WHERE id=?").run(boxA);
    expect((await download())?.status).toBe(404);
    f.sql.prepare("UPDATE mailboxes SET status='active' WHERE id=?").run(boxA);
    f.sql.prepare("UPDATE mail_app_passwords SET revoked_at='2026-10-08' WHERE id=?").run(login.id);
    expect((await download())?.status).toBe(404);
  });
  it('uses the standard port by default and rejects invalid port configuration', () => {
    f.env.BRIDGE_SMTP_PORT = '';
    expect(bridgeSettings(f.env).smtpPort).toBe(465);
    f.env.BRIDGE_SMTP_PORT = '443:465';
    expect(() => bridgeSettings(f.env)).toThrow('Invalid bridge SMTP port');
  });
});
