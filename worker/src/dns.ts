export const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/\.$/, '');
export const cloudflareMx = (hosts: string[]) =>
  hosts.length > 0 && hosts.every((host) => normalizeHost(host).endsWith('.mx.cloudflare.net'));

export async function receivingDns(name: string) {
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.search = new URLSearchParams({ name, type: 'MX' }).toString();
  const response = await fetch(url, {
    headers: { Accept: 'application/dns-json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('DNS lookup failed. Try again.');
  const dns = (await response.json()) as {
    Status: number;
    TC?: boolean;
    Answer?: { type: number; data: string }[];
  };
  // An incomplete answer cannot establish whether receiving is enabled.
  if (dns.TC || ![0, 3].includes(dns.Status))
    throw new Error('DNS could not be verified. The previous status has been kept.');
  const hosts = (dns.Answer || [])
    .filter((answer) => answer.type === 15)
    .map((answer) => {
      const mx = /^\d+\s+(\S+)\s*$/.exec(answer.data);
      if (!mx) throw new Error('DNS returned an invalid mail record. Try again.');
      return mx[1];
    });
  return { receiving: cloudflareMx(hosts), hasMx: hosts.length > 0 };
}
