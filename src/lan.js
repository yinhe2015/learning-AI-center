import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { domainToASCII } from 'node:url';
import { join } from 'node:path';
import { root } from './store.js';

function selectAddress() {
  const interfaces = networkInterfaces();
  const valid = entry => entry.family === 'IPv4' && !entry.internal;
  const requested = process.env.WORKBENCH_LAN_ADDRESS;
  if (requested) {
    if (Object.values(interfaces).flat().some(entry => valid(entry) && entry.address === requested)) return requested;
    throw new Error('WORKBENCH_LAN_ADDRESS 须为本机一个已启用的非回环 IPv4 地址。');
  }
  const route = execFileSync('/sbin/route', ['-n', 'get', 'default'], { encoding: 'utf8' });
  const name = route.match(/^\s*interface:\s*(\S+)/m)?.[1];
  const entry = interfaces[name]?.find(valid);
  if (entry && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(entry.address)) return entry.address;
  throw new Error('找不到默认局域网地址。请设置 WORKBENCH_LAN_ADDRESS。');
}

function openssl(args) {
  execFileSync('openssl', args, { stdio: 'pipe', env: { ...process.env, OPENSSL_CONF: '/dev/null' } });
}

export function prepareLan() {
  const address = selectAddress();
  const configuredHost = process.env.WORKBENCH_LAN_HOSTNAME;
  const hostname = configuredHost ? domainToASCII(configuredHost).toLowerCase() : null;
  if (configuredHost && (/[\/:@?#\s\\]/.test(configuredHost) || !hostname || hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname))) {
    throw new Error('WORKBENCH_LAN_HOSTNAME 必须是域名，不含协议、路径或端口。');
  }
  const tlsDir = join(root, 'tls');
  mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  const caDir = join(tlsDir, 'ca');
  const caKey = join(caDir, 'ca.key');
  const caCert = join(caDir, 'ca.crt');
  const scratch = mkdtempSync(join(tlsDir, 'issue-'));
  try {
    const config = join(scratch, 'openssl.cnf');
    writeFileSync(config, `[req]
prompt = no
distinguished_name = ca_name
[ca_name]
CN = Codex Workbench LAN CA
[ca]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[server]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:${address}${hostname ? `,DNS:${hostname}` : ''}
`);
    if (!existsSync(caDir)) {
      const newCa = join(scratch, 'ca');
      mkdirSync(newCa, { mode: 0o700 });
      openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '1825', '-config', config,
        '-extensions', 'ca', '-keyout', join(newCa, 'ca.key'), '-out', join(newCa, 'ca.crt')]);
      renameSync(newCa, caDir);
    }
    openssl(['x509', '-in', caCert, '-checkend', '0', '-noout']);
    const key = join(scratch, 'server.key');
    const csr = join(scratch, 'server.csr');
    const cert = join(scratch, 'server.crt');
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-config', config,
      '-subj', `/CN=${address}`, '-keyout', key, '-out', csr]);
    const serial = '0x' + randomBytes(16).toString('hex');
    openssl(['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-set_serial', serial,
      '-days', '365', '-sha256', '-extfile', config, '-extensions', 'server', '-out', cert]);
    return { address, hostname, caCert, key: readFileSync(key), cert: readFileSync(cert) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
