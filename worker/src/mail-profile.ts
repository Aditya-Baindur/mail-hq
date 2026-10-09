import { bridgeSettings } from './bridge';
import { AppError, type Env } from './model';

const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
type Plist = string | number | boolean | { [key: string]: Plist } | Plist[];
function plist(value: Plist): string {
  if (typeof value === 'string') return `<string>${xml(value)}</string>`;
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (Array.isArray(value)) return `<array>${value.map(plist).join('')}</array>`;
  return `<dict>${Object.entries(value).map(([key, v]) => `<key>${xml(key)}</key>${plist(v)}`).join('')}</dict>`;
}

// Only account settings are downloaded. Apple prompts for the app password;
// the profile never contains passwords, certificates, VPN or MDM payloads.
export async function mailAppProfile(env: Env, credentialId: string) {
  const settings = bridgeSettings(env);
  if (!settings.configured || !settings.host) throw new AppError(503, 'The mail bridge is not configured.');
  const account = await env.DB.prepare(`SELECT p.id,m.id AS mailbox_id,m.address,m.name FROM mail_app_passwords p
    JOIN mailboxes m ON m.id=p.mailbox_id WHERE p.id=? AND p.revoked_at IS NULL AND m.status='active'`)
    .bind(credentialId).first<{ id: string; mailbox_id: string; address: string; name: string }>();
  if (!account) throw new AppError(404, 'Active mail-app connection not found');
  const identifier = `com.mailhq.account.${account.mailbox_id}`;
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">' + plist({
    PayloadType: 'Configuration', PayloadVersion: 1, PayloadIdentifier: identifier,
    PayloadUUID: account.mailbox_id, PayloadDisplayName: `MailHQ — ${account.address}`,
    PayloadDescription: 'Adds your MailHQ email account with SSL. Enter your MailHQ app password when prompted.',
    PayloadRemovalDisallowed: false,
    PayloadContent: [{
      PayloadType: 'com.apple.mail.managed', PayloadVersion: 1,
      PayloadIdentifier: `${identifier}.mail`, PayloadUUID: account.id,
      PayloadDisplayName: `MailHQ — ${account.address}`,
      EmailAccountDescription: `MailHQ — ${account.address}`, EmailAccountName: account.name || account.address,
      EmailAccountType: 'EmailTypeIMAP', EmailAddress: account.address,
      IncomingMailServerAuthentication: 'EmailAuthPassword', IncomingMailServerHostName: settings.host,
      IncomingMailServerPortNumber: settings.imapPort, IncomingMailServerUsername: account.address, IncomingMailServerUseSSL: true,
      OutgoingMailServerAuthentication: 'EmailAuthPassword', OutgoingMailServerHostName: settings.host,
      OutgoingMailServerPortNumber: settings.smtpPort, OutgoingMailServerUsername: account.address, OutgoingMailServerUseSSL: true,
      OutgoingPasswordSameAsIncomingPassword: true,
    }],
  }) + '</plist>\n';
  return new Response(body, { headers: {
    'Content-Type': 'application/x-apple-aspen-config',
    'Content-Disposition': `attachment; filename="mailhq-${account.mailbox_id}.mobileconfig"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}
