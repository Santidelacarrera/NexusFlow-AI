import { lookup as dnsLookup } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';

const ALLOWED_PORTS = new Set([443, 8443]);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** True si la IP pertenece a rangos privados/loopback/link-local/metadata/multicast (IPv4 e IPv6, incl. IPv4-mapped). */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    // Solo IPv6 global unicast 2000::/3. Bloquea formas expandidas de loopback y direcciones de transición.
    if (!/^[23][0-9a-f]{3}:/.test(lower) || /^200[12]:/.test(lower)) return true;
    return /^(fc|fd|fe[89ab]|ff|2001:db8|64:ff9b)/.test(lower);
  }
  return true; // no es una IP válida: bloquear por defecto
}

export interface UrlPolicy {
  allowlist: string[];
}

/** Validación sintáctica (sin DNS). Solo https, sin credenciales embebidas, puertos restringidos. */
export function validateUrlSyntax(raw: string, policy: UrlPolicy): URL {
  if (raw.length > 2048) throw new Error('URL demasiado larga');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL inválida');
  }
  if (url.protocol !== 'https:') throw new Error('Solo se permiten URLs https');
  if (url.username || url.password) throw new Error('No se permiten credenciales en la URL');
  const port = url.port ? Number(url.port) : 443;
  if (!ALLOWED_PORTS.has(port)) throw new Error('Puerto no permitido');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) throw new Error('Destino no permitido');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw new Error('Destino no permitido');
  }
  if (policy.allowlist.length > 0 && !policy.allowlist.includes(host))
    throw new Error('Host fuera de la lista de permitidos');
  return url;
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/** `lookup` seguro: valida CADA dirección resuelta en el momento de conectar (anti DNS-rebinding / TOCTOU). */
function safeLookup(hostname: string, options: { all?: boolean }, cb: LookupCb): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const safe = addresses.filter((a) => !isPrivateAddress(a.address));
    if (safe.length === 0 || safe.length !== addresses.length) {
      return cb(Object.assign(new Error('Destino no permitido'), { code: 'EBLOCKED' }), '');
    }
    if (options.all) return cb(null, safe);
    cb(null, safe[0].address, safe[0].family);
  });
}

export interface SafeFetchOptions extends UrlPolicy {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  status: number;
  body: string;
  truncated: boolean;
}

const BLOCKED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
]);

/** Cliente HTTP saliente endurecido: https only, sin redirects, timeout, tope de tamaño, DNS validado al conectar. */
export function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const url = validateUrlSyntax(rawUrl, opts);
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const headers: Record<string, string> = { 'user-agent': 'NexusFlow-AI/1.0' };
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (!BLOCKED_HEADERS.has(k.toLowerCase()) && /^[\w-]+$/.test(k) && !/[\r\n]/.test(v)) headers[k] = v;
  }
  if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));

  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: opts.method ?? 'GET', headers, lookup: safeLookup as never, timeout: opts.timeoutMs ?? 5000 },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), truncated });
        };
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', done);
        res.on('close', done);
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado')));
    req.on('error', reject);
    if (opts.signal) {
      if (opts.signal.aborted) req.destroy(new Error('Solicitud abortada'));
      else
        opts.signal.addEventListener('abort', () => req.destroy(new Error('Solicitud abortada')), {
          once: true,
        });
    }
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
