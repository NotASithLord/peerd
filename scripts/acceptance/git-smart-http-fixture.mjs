// Secretless, loopback-only Smart HTTP fixture for installed-browser acceptance.
//
// The public-looking HTTPS name is intentional: production rejects localhost,
// raw-IP, cleartext, credential-bearing, and non-443 Git remotes. Browsers reach
// this process through the returned loopback CONNECT proxy, so no DNS, Internet,
// or privileged port is needed. The bearer value is random, process-local test
// data. It is never returned by binding(), snapshot(), or verification methods.

import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createProxyServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GIT_FIXTURE_SCHEMA = 1;
export const GIT_FIXTURE_HOST = 'git-fixture.peerd.test';
export const GIT_FIXTURE_REPOSITORY = 'acceptance/cutover.git';
export const GIT_FIXTURE_REMOTE = `https://${GIT_FIXTURE_HOST}/${GIT_FIXTURE_REPOSITORY}`;
export const GIT_FIXTURE_MAX_BODY_BYTES = 40 * 1024 * 1024;
export const GIT_FIXTURE_EXPECTED_REQUESTS = Object.freeze({
  receiveInfoRefs: 1,
  receivePack: 1,
  uploadInfoRefs: 3,
  uploadPack: 3,
  total: 8,
});

// Static test-only leaf key. It authenticates no person or service; its sole
// purpose is deterministic TLS identity for the loopback acceptance fixture.
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDRjCCAi6gAwIBAgIUIZnyfY/MyVJ6XLkhBAQFQeffwdUwDQYJKoZIhvcNAQEL
BQAwITEfMB0GA1UEAwwWZ2l0LWZpeHR1cmUucGVlcmQudGVzdDAeFw0yNjA4MjEw
NzEyMDBaFw0zNjA4MTgwNzEyMDBaMCExHzAdBgNVBAMMFmdpdC1maXh0dXJlLnBl
ZXJkLnRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCz/tZfwVj6
GjDx85v6vxNFuHBzO8t2O4qWi9HQUZNLtggZ6kYByZT15fZOsgdsDIDaR2Om34WO
ArHN4Z1qwjrvzSdniNYqrazSQpdxchCtJClXF8fjiJCCMqYxtwiGK/nQVBlKoFVa
W+ldTwKwZMxbfteJ0U42FadvhuNPUfxLWHqI6WlBLxqBegL65CG7i5tWFu7pmaK0
1Vg0xmB7JJrzL44qvW/g6knOny3fh/CtgvN3LEKMyQUWNryU9KEq/3g5/W5ZsrfQ
jbhIksV3D9GgQsW6zoG6HfOF1lDneiUDY+Kcl/BnEFqM7Lg4xMxItJKj3FYTZdcp
xhpYUHoMIogZAgMBAAGjdjB0MB0GA1UdDgQWBBS2XWhkwguXiTmN1D1qJdvSiLOm
LzAfBgNVHSMEGDAWgBS2XWhkwguXiTmN1D1qJdvSiLOmLzAPBgNVHRMBAf8EBTAD
AQH/MCEGA1UdEQQaMBiCFmdpdC1maXh0dXJlLnBlZXJkLnRlc3QwDQYJKoZIhvcN
AQELBQADggEBAJ9JMCsbNL7GVge1llLk1ar15dYVqx1GTOi82D1CoTWgDxTCTWlr
jFv2Yy+3bB+1714ZF8SmvNVMfWf0oy/iZvgUlnznOzJQicMEMLL/Rfee6dhDC9Yu
IW/i0QAhyGkoQ6n/yndz1h8O760cU1QSh5hSqJOkc5xtT42N7RcrXyg3YwOf2WpQ
dQAWtbhox7JMw/yLr0BHnN125U4PW/R4bhol/5rcw5aQyRVzSCEJYioM65HfFPXy
6qreQNqnmf/aJLWOvfdydjizikjrCsA/zVNpjqJOY4kX9q5vVhxwKsrCrSzB0l79
jUmHoCeRcFcDD4bUmqgbzOuuI55FnVI/BW4=
-----END CERTIFICATE-----`;
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCz/tZfwVj6GjDx
85v6vxNFuHBzO8t2O4qWi9HQUZNLtggZ6kYByZT15fZOsgdsDIDaR2Om34WOArHN
4Z1qwjrvzSdniNYqrazSQpdxchCtJClXF8fjiJCCMqYxtwiGK/nQVBlKoFVaW+ld
TwKwZMxbfteJ0U42FadvhuNPUfxLWHqI6WlBLxqBegL65CG7i5tWFu7pmaK01Vg0
xmB7JJrzL44qvW/g6knOny3fh/CtgvN3LEKMyQUWNryU9KEq/3g5/W5ZsrfQjbhI
ksV3D9GgQsW6zoG6HfOF1lDneiUDY+Kcl/BnEFqM7Lg4xMxItJKj3FYTZdcpxhpY
UHoMIogZAgMBAAECggEALJd5rIdN78gFUCu1/MzRjXhAA4xQv53Im7tP43gSMbOL
FkB/z3mNOc4a0ywvwojmcy00dubxQ1lPi13VjdlImJgOpwuzYydbpUtyEVzc3MgU
pcrybmAqzNaXbcGWjwbeAMqU6XQHMTeL/N3SILkYF6K46x+7bJK4xFx6e/AnvNJn
NV9xWuCC6f1Be3uZnQ4+j3kGyyZjVD6Bcb6y/rz3wxR7QAQEu7v8lWTYSLCCcikR
nBjpTxF+jPhF7x0l3dua6Ty1w52WRrDp1d6BvhaEmPNiZbBfajE/2wlamP0BNjhl
6FkOgz7C2zCAH3gO7nagVVFBzI/aod4RWqrlUhrJ8QKBgQD3sK9QnmezjBJUO1TK
5brlb3QJQddExE4PXPQGQ4so9683BdH/LUPWB7ZtjcGsXEgcahwL55Gz0PErbLgA
5crazSr3MUZyal9aG6X2hyTDhKCeTLEnWwwO0r0Bor3lmO3AqJBesFGh5J0QyLTI
DNyGFzPcQlggezCjKUtI0FzXPwKBgQC6CL+yrbk/DyKA4ovqiL8OnOoRK662kveV
yL7qTw/Zy2ATNdV67EaEqGyKXuFmhaX/xpMfwFrc/oasGP0JTA6SX+YYjFXqIgP6
Cjs1y2WOpwSNlg6j7uvkocx3B0/L0j+zkciEduX7CgQroeKBYyzFSBOE42F7nx7o
IURja9RipwKBgQDRIvZkc9vL1nGDfbVSvDbakwi+6EEDZ10hy7Kft1hA9yGSq+9s
LqQgi9KVHiRxjFm25EFaK+Tyl3GK4PlciKqHpMSqg4igAwEP7FhtmB6Kl+mmv8q1
GENOINJGF0uQGVhmW+3KhcXnlEiqa015vKJW9jBrwfj3NA0VN0DB8mzxsQKBgQCk
qkPMC1tSBrp6rIw+H6ZFb/z7D9hIwJOnoBXk3fBgzlSPDHKWqHbOyymv3MXUcm35
lTH6w89pl11rDX9D8G9hfsLzbZxKbqtocg/w0MVm3Ez6ah0xW7SvHcwWe4FVHxfF
gT+kiH2OlFIWsOcFsdwaD28/i+hofPLlczTOb86BNwKBgQDdAYxyysrmAvQ+9NyP
/hX7hxjqL7qSHlyX1wyKG1yI3/Iy4duvIs7Sl6wzSl2AxkrOSLBGB2yO1xYvfYn1
Hytbn4ly2n86hWFjWvExsVVZ2jrlj5Q7Ijd1ZZoYAj6UWa1QywTc0UNJ+KrVYq5b
DeyWISpBmyLfSFO7lzUR0IO+pg==
-----END PRIVATE KEY-----`;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const HEX_256 = /^[a-f0-9]{64}$/;
const exactKeys = (value, keys) => value != null && typeof value === 'object'
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const listen = (server) => new Promise((resolve, reject) => {
  const fail = (error) => { server.off('listening', ready); reject(error); };
  const ready = () => { server.off('error', fail); resolve(); };
  server.once('error', fail);
  server.once('listening', ready);
  server.listen(0, '127.0.0.1');
});
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

const run = (command, args, { cwd, env, input, maxBytes = 64 * 1024 * 1024 } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) child.kill('SIGKILL');
      else target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const out = Buffer.concat(stdout);
      const error = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0 && bytes <= maxBytes) resolve(out);
      else reject(new Error(`${command} failed (${signal ?? code}): ${error || 'no diagnostics'}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });

const parseCgi = (buffer) => {
  let split = buffer.indexOf('\r\n\r\n');
  let width = 4;
  if (split < 0) { split = buffer.indexOf('\n\n'); width = 2; }
  if (split < 0 || split > 64 * 1024) throw new Error('git http-backend emitted invalid headers');
  const lines = buffer.subarray(0, split).toString('latin1').split(/\r?\n/);
  let status = 200;
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('git http-backend emitted a malformed header');
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
    else headers[name] = value;
  }
  return { status, headers, body: buffer.subarray(split + width) };
};

const requestKind = (url) => {
  const service = url.searchParams.get('service');
  if (url.pathname.endsWith('/info/refs') && service === 'git-upload-pack') return 'upload-info-refs';
  if (url.pathname.endsWith('/info/refs') && service === 'git-receive-pack') return 'receive-info-refs';
  if (url.pathname.endsWith('/git-upload-pack')) return 'upload-pack';
  if (url.pathname.endsWith('/git-receive-pack')) return 'receive-pack';
  return 'unknown';
};

export const summarizeGitFixtureRequests = (requests) => Object.freeze({
  receiveInfoRefs: requests.filter((entry) => entry.kind === 'receive-info-refs').length,
  receivePack: requests.filter((entry) => entry.kind === 'receive-pack').length,
  uploadInfoRefs: requests.filter((entry) => entry.kind === 'upload-info-refs').length,
  uploadPack: requests.filter((entry) => entry.kind === 'upload-pack').length,
  total: requests.length,
});

export const assertExactGitFixtureRequests = (summary) => {
  if (!exactKeys(summary, Object.keys(GIT_FIXTURE_EXPECTED_REQUESTS))) {
    throw new Error('Smart HTTP acceptance request summary shape mismatch');
  }
  for (const [key, expected] of Object.entries(GIT_FIXTURE_EXPECTED_REQUESTS)) {
    if (summary?.[key] !== expected) {
      throw new Error(`Smart HTTP acceptance request cardinality mismatch at ${key}: ${summary?.[key]} != ${expected}`);
    }
  }
  return summary;
};

export const assertGitFixtureBinding = (binding) => {
  const keys = [
    'schema', 'host', 'remote', 'gitVersion', 'certificateSha256',
    'protocolSha256', 'sha256',
  ];
  if (!exactKeys(binding, keys)
      || binding.schema !== GIT_FIXTURE_SCHEMA
      || binding.host !== GIT_FIXTURE_HOST
      || binding.remote !== GIT_FIXTURE_REMOTE
      || !/^git version \d+\.\d+\.\d+(?:[.-][^\s()]+)?(?: \(Apple Git-\d+\))?$/.test(binding.gitVersion)
      || !HEX_256.test(binding.certificateSha256)
      || !HEX_256.test(binding.protocolSha256)
      || !HEX_256.test(binding.sha256)) {
    throw new Error('Smart HTTP acceptance fixture binding is invalid');
  }
  const fields = {
    schema: binding.schema,
    host: binding.host,
    remote: binding.remote,
    gitVersion: binding.gitVersion,
    certificateSha256: binding.certificateSha256,
    protocolSha256: binding.protocolSha256,
  };
  if (sha256(JSON.stringify(fields)) !== binding.sha256) {
    throw new Error('Smart HTTP acceptance fixture binding digest mismatch');
  }
  return binding;
};

export const buildGitFixtureBinding = ({ gitVersion, certificateSha256, protocolSha256 }) => {
  const fields = {
    schema: GIT_FIXTURE_SCHEMA,
    host: GIT_FIXTURE_HOST,
    remote: GIT_FIXTURE_REMOTE,
    gitVersion,
    certificateSha256,
    protocolSha256,
  };
  return Object.freeze({ ...fields, sha256: sha256(JSON.stringify(fields)) });
};

export const assertGitFixtureSnapshot = (snapshot) => {
  if (!exactKeys(snapshot, ['schema', 'requests', 'summary'])
      || snapshot.schema !== GIT_FIXTURE_SCHEMA
      || !Array.isArray(snapshot.requests)
      || snapshot.requests.length !== GIT_FIXTURE_EXPECTED_REQUESTS.total) {
    throw new Error('Smart HTTP acceptance fixture snapshot shape mismatch');
  }
  for (const [index, entry] of snapshot.requests.entries()) {
    if (!exactKeys(entry, [
      'sequence', 'method', 'path', 'kind', 'authenticated', 'requestBytes',
    ])
        || entry.sequence !== index + 1
        || !['GET', 'POST'].includes(entry.method)
        || entry.authenticated !== true
        || !Number.isInteger(entry.requestBytes) || entry.requestBytes < 0
        || !String(entry.path ?? '').startsWith(`/${GIT_FIXTURE_REPOSITORY}/`)) {
      throw new Error('Smart HTTP acceptance fixture request ledger is invalid');
    }
  }
  assertExactGitFixtureRequests(snapshot.summary);
  assertExactGitFixtureRequests(summarizeGitFixtureRequests(snapshot.requests));
  const order = snapshot.requests.map((entry) => entry.kind);
  const expectedOrder = [
    'receive-info-refs', 'receive-pack',
    'upload-info-refs', 'upload-pack',
    'upload-info-refs', 'upload-pack',
    'upload-info-refs', 'upload-pack',
  ];
  if (order.join(',') !== expectedOrder.join(',')) {
    throw new Error('Smart HTTP acceptance fixture request order mismatch');
  }
  return snapshot;
};

export const assertSecretlessGitReport = (report, credential) => {
  const serialized = JSON.stringify(report);
  const forbidden = [credential?.token, credential?.authorization]
    .filter((value) => typeof value === 'string' && value.length > 0);
  if (forbidden.some((value) => serialized.includes(value))) {
    throw new Error('Smart HTTP acceptance report contains fixture credential material');
  }
  return report;
};

export const redactGitFixtureCredential = (value, credential) => {
  let output = String(value ?? '');
  for (const forbidden of [credential?.token, credential?.authorization]) {
    if (typeof forbidden === 'string' && forbidden.length > 0) {
      output = output.split(forbidden).join('[fixture-credential-redacted]');
    }
  }
  return output;
};

export const startGitSmartHttpFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), 'peerd-smart-http-'));
  const repositoryRoot = join(root, 'repositories');
  const repositoryPath = join(repositoryRoot, GIT_FIXTURE_REPOSITORY);
  const token = randomBytes(24).toString('hex');
  const authorization = `Basic ${Buffer.from(`git:${token}`, 'utf8').toString('base64')}`;
  const requests = [];
  let httpsServer;
  let proxyServer;
  try {
    await run('git', ['init', '--bare', repositoryPath]);
    await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repositoryPath });
    await run('git', ['config', 'http.receivepack', 'true'], { cwd: repositoryPath });
    const gitVersion = (await run('git', ['--version'])).toString('utf8').trim();

    httpsServer = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, async (request, response) => {
      const chunks = [];
      let bytes = 0;
      request.on('data', (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > GIT_FIXTURE_MAX_BODY_BYTES) request.destroy(new Error('fixture request too large'));
        else chunks.push(chunk);
      });
      request.on('end', async () => {
        const url = new URL(request.url ?? '/', GIT_FIXTURE_REMOTE);
        const kind = requestKind(url);
        const authenticated = request.headers.authorization === authorization;
        const row = Object.freeze({
          sequence: requests.length + 1,
          method: request.method ?? '',
          path: url.pathname,
          kind,
          authenticated,
          requestBytes: bytes,
        });
        requests.push(row);
        if (!authenticated) {
          response.writeHead(401, {
            'www-authenticate': 'Basic realm="peerd acceptance"',
            'cache-control': 'no-store',
          });
          response.end('authentication required');
          return;
        }
        if (kind === 'unknown' || !url.pathname.startsWith(`/${GIT_FIXTURE_REPOSITORY}/`)) {
          response.writeHead(404, { 'cache-control': 'no-store' });
          response.end('fixture route not found');
          return;
        }
        try {
          const output = await run('git', ['http-backend'], {
            input: Buffer.concat(chunks),
            maxBytes: GIT_FIXTURE_MAX_BODY_BYTES + 2 * 1024 * 1024,
            env: {
              GIT_PROJECT_ROOT: repositoryRoot,
              GIT_HTTP_EXPORT_ALL: '1',
              REQUEST_METHOD: request.method ?? 'GET',
              PATH_INFO: url.pathname,
              QUERY_STRING: url.searchParams.toString(),
              CONTENT_TYPE: request.headers['content-type'] ?? '',
              CONTENT_LENGTH: String(bytes),
              REMOTE_USER: 'git',
              REMOTE_ADDR: request.socket.remoteAddress ?? '127.0.0.1',
              SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
            },
          });
          const cgi = parseCgi(output);
          if (kind === 'receive-pack' && cgi.status >= 200 && cgi.status < 300) {
            await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/acceptance/cutover'], {
              cwd: repositoryPath,
            });
          }
          response.writeHead(cgi.status, { ...cgi.headers, 'cache-control': 'no-store' });
          response.end(cgi.body);
        } catch (error) {
          response.writeHead(500, { 'cache-control': 'no-store' });
          response.end(`fixture backend failure: ${String(error?.message ?? error)}`);
        }
      });
    });
    await listen(httpsServer);
    const httpsAddress = httpsServer.address();
    if (!httpsAddress || typeof httpsAddress === 'string') throw new Error('fixture TLS address unavailable');

    proxyServer = createProxyServer((socket) => socket.destroy());
    proxyServer.on('error', () => {});
    proxyServer.on('connection', (socket) => socket.setTimeout(30_000, () => socket.destroy()));
    proxyServer.on('connect', (request, client, head) => {
      if (request.url !== `${GIT_FIXTURE_HOST}:443` || request.headers['proxy-authorization']) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      const upstream = connect(httpsAddress.port, '127.0.0.1');
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    await listen(proxyServer);
    const proxyAddress = proxyServer.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('fixture proxy address unavailable');

    const certificate = new X509Certificate(TLS_CERT);
    const certificateSha256 = sha256(certificate.raw);
    const spkiSha256Base64 = createHash('sha256')
      .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
    const binding = buildGitFixtureBinding({
      gitVersion,
      certificateSha256,
      protocolSha256: sha256(JSON.stringify({
        schema: GIT_FIXTURE_SCHEMA,
        host: GIT_FIXTURE_HOST,
        repository: GIT_FIXTURE_REPOSITORY,
        maxBodyBytes: GIT_FIXTURE_MAX_BODY_BYTES,
        expectedRequests: GIT_FIXTURE_EXPECTED_REQUESTS,
      })),
    });
    const credential = Object.freeze({ host: GIT_FIXTURE_HOST, token, authorization });
    return Object.freeze({
      remote: GIT_FIXTURE_REMOTE,
      proxyServer: Object.freeze({
        url: `http://127.0.0.1:${proxyAddress.port}`,
        certificateSpkiSha256: spkiSha256Base64,
      }),
      // Deliberately separate from every serializable evidence method.
      credential: () => credential,
      binding: () => binding,
      snapshot: () => Object.freeze({
        schema: GIT_FIXTURE_SCHEMA,
        requests: Object.freeze(requests.map((entry) => ({ ...entry }))),
        summary: summarizeGitFixtureRequests(requests),
      }),
      verifyBranch: async (branch, expected) => {
        if (!/^[a-z0-9][a-z0-9/_-]{0,79}$/i.test(branch)) throw new Error('invalid fixture branch');
        const oid = (await run('git', ['rev-parse', `refs/heads/${branch}`], { cwd: repositoryPath }))
          .toString('utf8').trim();
        const files = {};
        for (const [path, value] of Object.entries(expected)) {
          if (!/^[a-z0-9][a-z0-9/_.-]{0,199}$/i.test(path) || path.includes('..')) {
            throw new Error('invalid fixture verification path');
          }
          const actual = await run('git', ['show', `${oid}:${path}`], { cwd: repositoryPath });
          const expectedBytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
          if (!actual.equals(expectedBytes)) throw new Error(`fixture branch payload mismatch: ${path}`);
          files[path] = sha256(actual);
        }
        return Object.freeze({ branch, oid, files: Object.freeze(files) });
      },
      close: async () => {
        await Promise.allSettled([proxyServer ? close(proxyServer) : null, httpsServer ? close(httpsServer) : null]);
        rmSync(root, { recursive: true, force: true });
      },
    });
  } catch (error) {
    await Promise.allSettled([proxyServer ? close(proxyServer) : null, httpsServer ? close(httpsServer) : null]);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
};
