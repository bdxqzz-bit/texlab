#!/usr/bin/env node
/**
 * Self-test for the proxy: builds a throwaway RSA key pair, mints Firebase-shaped ID tokens and
 * drives the real server over HTTP with a stubbed Airtable fetch. Verifies that token checks and
 * the member restriction are enforced by the server, not the app.
 *
 *   node server/selftest.mjs
 */
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { createProxyServer } from './index.mjs';

const PROJECT_ID = 'test-project';
const BASE = 'appTESTBASE123456';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const getCert = async (kid) => (kid === 'test-kid' ? publicPem : null);

function mintToken(claims = {}, { kid = 'test-kid', alg = 'RS256', key = privateKey } = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: 'uid-1',
      iat: nowSeconds - 30,
      exp: nowSeconds + 3600,
      email: 'member@example.com',
      email_verified: true,
      name: 'Member One',
      ...claims,
    }),
  ).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

const ISO_RECORD = {
  id: 'recAAAAAAAAAAAAAA',
  fields: {
    Method: 'ISO 1833-17',
    'Method Name': 'Quantitative chemical analysis',
    Scope: 'Determination of cellulose fibre mixtures.',
    File: [
      {
        id: 'attPDF00000000001',
        url: 'https://files.example/iso-1833-17.pdf',
        filename: 'ISO-1833-17-2019.pdf',
        size: 12,
        type: 'application/pdf',
      },
    ],
  },
};

const PDF_BYTES = Buffer.from('%PDF-1.4\n% selftest\n');

const airtableCalls = [];
const fetchImpl = async (input, init = {}) => {
  const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  airtableCalls.push(url.pathname + url.search);
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (url.hostname === 'api.airtable.com') {
    assert.equal(init.headers?.Authorization, 'Bearer test-airtable-token');
    const [, , , table, recordId] = url.pathname.split('/');

    if (table === 'Members') {
      const formula = decodeURIComponent(url.searchParams.get('filterByFormula') || '');
      const known = ['member@example.com', 'revoked@example.com', 'pending@example.com'];
      const email = known.find((candidate) => formula.includes(candidate));
      const emailFields = email ? { Email: email } : {};
      const status =
        email === 'revoked@example.com' ? 'Revoked' : email === 'pending@example.com' ? 'Pending' : 'Active';
      return json({
        records: email
          ? [{ id: 'recMEMBER0000001', fields: { Name: 'Member One', Role: 'Admin', Status: status, ...emailFields } }]
          : [],
      });
    }
    if (recordId) return json(ISO_RECORD);
    if (table === 'ISO') return json({ records: [ISO_RECORD] });
    if (table === 'AATCC') return json({ records: [] });
    return json({ records: [] });
  }

  if (url.hostname === 'files.example') {
    return new Response(PDF_BYTES, { status: 200, headers: { 'content-type': 'application/pdf' } });
  }

  return json({ error: { message: 'unexpected host' } }, 500);
};

const config = {
  port: 0,
  airtableToken: 'test-airtable-token',
  baseId: BASE,
  methodsTables: ['ISO', 'AATCC'],
  membersTable: 'Members',
  projectId: PROJECT_ID,
  membershipTtlMs: 0, // no caching in the test, so revocation is visible immediately
};

const server = createProxyServer({ config, fetchImpl, getCert });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}\n     ${error.message}`);
    process.exitCode = 1;
  }
}

async function request(path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${base}${path}`, { headers });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

const memberToken = mintToken();

await check('healthz answers without a token', async () => {
  const { status, body } = await request('/healthz');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

await check('no Authorization header is rejected', async () => {
  const { status, body } = await request('/api/methods');
  assert.equal(status, 401);
  assert.equal(body.error, 'missing_token');
});

await check('garbage token is rejected', async () => {
  const { status, body } = await request('/api/methods', 'not-a-jwt');
  assert.equal(status, 401);
  assert.equal(body.error, 'invalid_token');
});

await check('token signed by another key is rejected', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const { status } = await request('/api/methods', mintToken({}, { key: other }));
  assert.equal(status, 401);
});

await check('HS256 token is rejected (no algorithm confusion)', async () => {
  const forged = mintToken({}, { alg: 'HS256', key: privateKey });
  const { status } = await request('/api/methods', forged);
  assert.equal(status, 401);
});

await check('token for another audience/project is rejected', async () => {
  const { status } = await request('/api/methods', mintToken({ aud: 'someone-else' }));
  assert.equal(status, 401);
  const { status: badIssuer } = await request(
    '/api/methods',
    mintToken({ iss: 'https://securetoken.google.com/someone-else' }),
  );
  assert.equal(badIssuer, 401);
});

await check('expired token is rejected', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { status, body } = await request(
    '/api/methods',
    mintToken({ iat: nowSeconds - 7200, exp: nowSeconds - 600 }),
  );
  assert.equal(status, 401);
  assert.equal(body.error, 'token_expired');
});

await check('valid member token gets the merged library', async () => {
  const { status, body } = await request('/api/methods', memberToken);
  assert.equal(status, 200);
  assert.equal(body.methods.length, 1);
  const method = body.methods[0];
  assert.equal(method.title, 'ISO 1833-17');
  assert.equal(method.category, 'ISO');
  assert.equal(method.summary, 'Determination of cellulose fibre mixtures.');
  assert.equal(method.pdf.filename, 'ISO-1833-17-2019.pdf');
  assert.equal(method.pdf.url, '/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001');
  assert.equal(body.methods[0].pdf.url.includes('files.example'), false, 'must not leak the Airtable URL');
});

await check('/api/me returns the member identity', async () => {
  const { status, body } = await request('/api/me', memberToken);
  assert.equal(status, 200);
  assert.deepEqual(body, { member: true, name: 'Member One', role: 'Admin' });
});

await check('signed-in but unknown email is refused with 403', async () => {
  const { status, body } = await request('/api/methods', mintToken({ email: 'stranger@example.com' }));
  assert.equal(status, 403);
  assert.equal(body.error, 'not_a_member');
});

await check('revoked and pending members are refused', async () => {
  for (const email of ['revoked@example.com', 'pending@example.com']) {
    const { status, body } = await request('/api/methods', mintToken({ email }));
    assert.equal(status, 403, `${email} should be refused`);
    assert.equal(body.error, 'not_a_member');
  }
});

await check('member token streams the PDF through the proxy', async () => {
  const response = await fetch(
    `${base}/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001`,
    { headers: { Authorization: `Bearer ${memberToken}` } },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length === PDF_BYTES.length && bytes.equals(PDF_BYTES));
});

await check('non-member cannot download a PDF', async () => {
  const response = await fetch(
    `${base}/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001`,
    { headers: { Authorization: `Bearer ${mintToken({ email: 'stranger@example.com' })}` } },
  );
  assert.equal(response.status, 403);
});

await check('unauthenticated PDF download is rejected', async () => {
  const response = await fetch(`${base}/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001`);
  assert.equal(response.status, 401);
});

await check('unknown tables/records are rejected', async () => {
  const foreignTable = await request('/api/files/Secret/recAAAAAAAAAAAAAA/attPDF00000000001', memberToken);
  assert.equal(foreignTable.status, 404);
  const badRecord = await request('/api/files/ISO/..%2Fetc/attPDF00000000001', memberToken);
  assert.ok(badRecord.status === 400 || badRecord.status === 404);
});

await check('no Airtable token or attachment URL appears in responses', async () => {
  const { body } = await request('/api/methods', memberToken);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('test-airtable-token'), false);
  assert.equal(serialized.includes('files.example'), false);
});

server.close();
console.log(`\n${passed} checks passed${process.exitCode ? ', with failures' : ''}.`);
if (process.exitCode) process.exit(process.exitCode);
