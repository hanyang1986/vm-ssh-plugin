import * as https from 'https';

/**
 * Detect the local machine's public (outbound) IPv4 address by querying a
 * small set of well-known "what is my IP" endpoints in order until one
 * answers. Used to open SSH access from the current location in a VM's NSG.
 */
const IP_SERVICES = [
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://icanhazip.com',
];

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export async function getLocalPublicIp(): Promise<string> {
  let lastErr: unknown;
  for (const url of IP_SERVICES) {
    try {
      const body = (await httpGet(url, 5000)).trim();
      if (IPV4.test(body)) {
        return body;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not determine your public IP address${
      lastErr instanceof Error ? `: ${lastErr.message}` : ''
    }`
  );
}

function httpGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'curl/8' } }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}
