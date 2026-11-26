#!/usr/bin/env node
/**
 * Self-test for the Worker port: builds a throwaway RSA key pair, mints Firebase-shaped ID
 * tokens, serves a stubbed Airtable + JWKS + PDF from a local HTTP server, and drives the Worker
 * handler directly. Verifies that token checks, the member restriction, open sign-up (Basic) and
 * the Google profile copy into the Members table all happen outside the app.
 *
 *   node worker/selftest.mjs
 *
 * Runs under plain Node because the Worker uses only WebCrypto and fetch. The same code is
 * exercised under real workerd by `wrangler dev` (see worker/README.md).
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createProxy } from './index.mjs';

const PROJECT_ID = 'test-project';
const BASE = 'appTESTBASE123456';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
publicJwk.kid = 'test-kid';
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';

function mintToken(claims = {}, { kid = 'test-kid', alg = 'RS256', key = privateKey } = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg, kid, typ: 'JWT' });
  const payload = encode({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: 'uid-1',
    iat: nowSeconds - 30,
    exp: nowSeconds + 3600,
    email: 'member@example.com',
    email_verified: true,
    name: 'Member One',
    ...claims,
  });
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

const ISO_RECORD = {
  id: 'recAAAAAAAAAAAAAA',
  fields: {
    Method: 'ISO 1833-17',
    'Method Name': 'Quantitative chemical analysis',
    Scope: 'Determination of cellulose fibre mixtures.',
    Version: '2019',
    // The lab paired this ISO method with an AATCC counterpart (Airtable `AATCC` link column).
    AATCC: ['recCCCCCCCCCCCCCC'],
    File: [
      {
        id: 'attPDF00000000001',
        url: 'PENDING_PDF_URL',
        filename: 'ISO-1833-17-2019.pdf',
        size: 12,
        type: 'application/pdf',
      },
    ],
  },
};

/** The counterpart of ISO_RECORD, with its own PDF, and linked back to it. */
const AATCC_RECORD = {
  id: 'recCCCCCCCCCCCCCC',
  fields: {
    Method: 'AATCC TM20A',
    'Method Name': 'Fiber Analysis: Quantitative',
    Scope: 'Quantitative fibre analysis by chemical dissolution.',
    Version: '2021',
    'ISO Counterpart': ['recAAAAAAAAAAAAAA'],
    File: [
      {
        id: 'attPDF00000000002',
        url: 'PENDING_AATCC_URL',
        filename: 'AATCC-TM20A-2021.pdf',
        size: 39,
        type: 'application/pdf',
      },
    ],
  },
};

/** A method the lab has not paired, so Ask AI answers from its own document only. */
const UNPAIRED_RECORD = {
  id: 'recBBBBBBBBBBBBBB',
  fields: {
    Method: 'ISO 2062',
    'Method Name': 'Yarns from packages',
    Scope: 'Single-end breaking force.',
    AATCC: [],
  },
};

const PDF_BYTES = Buffer.from('%PDF-1.4\n% worker selftest\n');
const AATCC_PDF_BYTES = Buffer.from('%PDF-1.4\n% aatcc counterpart selftest\n');
const METHODS_BY_ID = new Map([
  [ISO_RECORD.id, ISO_RECORD],
  [AATCC_RECORD.id, AATCC_RECORD],
  [UNPAIRED_RECORD.id, UNPAIRED_RECORD],
]);

// ---------------------------------------------------------------------------
// Stub upstream: Airtable API (read + write) + Google JWKS + the attachment CDN
// ---------------------------------------------------------------------------

/** email -> { id, fields } — the fake Members table. */
const members = new Map();
/** Messages table: record id -> { id, fields, createdTime }. */
const messages = new Map();
let nextMessage = 1;
const writes = [];
/** Every generateContent call the Worker made, so the prompt can be asserted on. */
const geminiCalls = [];
let nextRecord = 1;

function seedMember(email, fields) {
  const id = `recMEM${String(nextRecord).padStart(11, '0')}`;
  nextRecord += 1;
  members.set(email, { id, fields: { Email: email, ...fields } });
  return members.get(email);
}

seedMember('member@example.com', {
  Name: 'Member One',
  'First name': 'Member',
  'Last name': 'One',
  Status: 'Active',
  Role: 'Admin',
  Level: 'Max',
  Photo: 'https://lh3.googleusercontent.com/a/member',
});
// An administrator-created row with no profile columns yet: gets backfilled, keeps its level.
seedMember('pro@example.com', { Name: '', Status: 'Active', Level: 'Pro' });
seedMember('revoked@example.com', { Name: 'Revoked', Status: 'Revoked', Level: 'Basic' });
seedMember('pending@example.com', { Name: 'Pending', Status: 'Pending', Level: 'Basic' });
// Used up today's five Basic Ask AI questions, to prove the daily cap is enforced server-side.
const TODAY = new Date().toISOString().slice(0, 10);
seedMember('exhausted@example.com', {
  Name: 'Exhausted',
  Status: 'Active',
  Level: 'Basic',
  'Usage date': TODAY,
  'Views today': 0,
  'Downloads today': 0,
  'Ask AI today': 5,
});

const stub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'public, max-age=60' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  if (url.pathname === '/jwks') {
    return send(200, JSON.stringify({ keys: [publicJwk] }));
  }
  if (url.pathname === '/iso-1833-17.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    return res.end(PDF_BYTES);
  }
  if (url.pathname === '/aatcc-tm20a.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    return res.end(AATCC_PDF_BYTES);
  }

  if (url.pathname.startsWith('/gemini/models/')) {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    return req.on('end', () => {
      const parsed = JSON.parse(raw || '{}');
      geminiCalls.push({
        path: url.pathname,
        key: req.headers['x-goog-api-key'],
        body: parsed,
      });
      if (JSON.stringify(parsed).includes('FAILME')) {
        return send(500, { error: { message: 'upstream exploded' } });
      }
      return send(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: '' },
                { text: 'ISO 1833-17 covers cellulose fibre mixtures.' },
              ],
            },
          },
        ],
      });
    });
  }

  assert.equal(req.headers.authorization, 'Bearer test-airtable-token', 'Airtable token must be sent');

  const table = parts[2];
  const recordId = parts[3];

  if (table === 'Messages') {
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      return req.on('end', () => {
        const fields = JSON.parse(raw || '{}').fields || {};
        const id = `recMSG${String(nextMessage).padStart(11, '0')}`;
        nextMessage += 1;
        const record = { id, fields, createdTime: new Date().toISOString() };
        messages.set(id, record);
        writes.push({ method: 'POST', table, fields });
        return send(200, record);
      });
    }
    return send(200, { records: [...messages.values()] });
  }

  if (table === 'Members') {
    if (req.method === 'GET' && recordId) {
      const record = [...members.values()].find((candidate) => candidate.id === recordId);
      return record ? send(200, record) : send(404, { error: { type: 'NOT_FOUND' } });
    }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      return req.on('end', () => {
        const fields = JSON.parse(raw || '{}').fields || {};
        if (fields.Email === 'nowrite@example.com') {
          return send(403, {
            error: { type: 'INVALID_PERMISSIONS', message: 'Token is missing data.records:write' },
          });
        }
        writes.push({ method: 'POST', fields });
        const record = seedMember(fields.Email, fields);
        return send(200, record);
      });
    }
    if (req.method === 'PATCH') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      return req.on('end', () => {
        const fields = JSON.parse(raw || '{}').fields || {};
        writes.push({ method: 'PATCH', recordId, fields });
        for (const record of members.values()) {
          if (record.id === recordId) Object.assign(record.fields, fields);
        }
        return send(200, { id: recordId, fields });
      });
    }

    const formula = decodeURIComponent(url.searchParams.get('filterByFormula') || '');
    if (!formula) return send(200, { records: [...members.values()] });
    const email = [...members.keys()].find((candidate) => formula.includes(candidate));
    if (!email) return send(200, { records: [] });
    return send(200, { records: [members.get(email)] });
  }

  if (recordId) {
    const method = METHODS_BY_ID.get(recordId);
    return method ? send(200, method) : send(404, { error: { type: 'NOT_FOUND' } });
  }
  if (table === 'ISO') return send(200, { records: [ISO_RECORD] });
  return send(200, { records: [] });
});

await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${stub.address().port}`;
ISO_RECORD.fields.File[0].url = `${origin}/iso-1833-17.pdf`;
AATCC_RECORD.fields.File[0].url = `${origin}/aatcc-tm20a.pdf`;

const env = {
  AIRTABLE_TOKEN: 'test-airtable-token',
  AIRTABLE_BASE_ID: BASE,
  AIRTABLE_METHODS_TABLE: 'ISO,AATCC',
  AIRTABLE_MEMBERS_TABLE: 'Members',
  FIREBASE_PROJECT_ID: PROJECT_ID,
  MEMBERSHIP_CACHE_SECONDS: '0', // no caching, so revocation is visible immediately
  GOOGLE_JWKS_URL: `${origin}/jwks`,
  AIRTABLE_API_BASE: `${origin}/v0`,
  APP_VERSION_CODE: '3',
  APP_VERSION_NAME: '1.2',
  APP_MIN_SUPPORTED: '2',
  APP_APK_URL: 'https://downloads.example.com/texlab-1.2.apk',
  APP_RELEASE_NOTES: 'Faster PDF viewer.',
  GEMINI_API_KEY: 'test-gemini-key',
  GEMINI_MODEL: 'gemini-test',
  GEMINI_API_BASE: `${origin}/gemini`,
  GEMINI_RPM: '100',
};

const handle = createProxy({ env });
const base = 'https://texlab-proxy.example';

async function request(path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await handle(new Request(`${base}${path}`, { headers }));
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

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

const memberToken = mintToken();
const googleClaims = (email, first, last, photo) => ({
  email,
  name: `${first} ${last}`,
  given_name: first,
  family_name: last,
  picture: photo,
});

await check('healthz answers without a token', async () => {
  const { status, body } = await request('/healthz');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.configured, true);
});

await check('the app update endpoint publishes the newest build without a token', async () => {
  const { status, body, headers } = await request('/api/app/latest');
  assert.equal(status, 200);
  assert.equal(body.app, 'texlab');
  assert.equal(body.versionCode, 3);
  assert.equal(body.versionName, '1.2');
  assert.equal(body.minSupported, 2);
  assert.equal(body.downloadUrl, 'https://downloads.example.com/texlab-1.2.apk');
  assert.equal(body.notes, 'Faster PDF viewer.');
  assert.equal(body.configured, true);
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(body).includes('test-airtable-token'), 'no server configuration may leak');
});

await check('the app update endpoint serves GET and HEAD only', async () => {
  const post = await handle(new Request(`${base}/api/app/latest`, { method: 'POST' }));
  assert.equal(post.status, 405);
  await post.text();
  const head = await handle(new Request(`${base}/api/app/latest`, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  await head.text();
});

await check('update defaults tell an app nothing to install and force nobody', async () => {
  const {
    APP_VERSION_CODE,
    APP_VERSION_NAME,
    APP_MIN_SUPPORTED,
    APP_APK_URL,
    APP_RELEASE_NOTES,
    ...plainEnv
  } = env;
  const plain = createProxy({ env: plainEnv });
  const response = await plain(new Request(`${base}/api/app/latest`));
  const body = await response.json();
  assert.equal(body.versionCode, 2);
  assert.equal(body.minSupported, 1);
  assert.equal(body.downloadUrl, '');
  assert.equal(body.configured, false);
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
  const { status } = await request('/api/methods', mintToken({}, { alg: 'HS256' }));
  assert.equal(status, 401);
});

await check('unknown kid is rejected', async () => {
  const { status } = await request('/api/methods', mintToken({}, { kid: 'other-kid' }));
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
  assert.equal(method.name, 'Quantitative chemical analysis');
  assert.equal(method.year, '2019');
  assert.equal(method.category, 'ISO');
  assert.equal(method.summary, 'Determination of cellulose fibre mixtures.');
  assert.equal(method.pdf.filename, 'ISO-1833-17-2019.pdf');
  assert.equal(method.pdf.url, '/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001');
  assert.equal(JSON.stringify(body).includes('iso-1833-17.pdf'), false, 'must not leak the Airtable URL');
});

await check('/api/me returns the level and the Google profile', async () => {
  const { status, body } = await request('/api/me', memberToken);
  assert.equal(status, 200);
  assert.deepEqual(body, {
    member: true,
    level: 'max',
    levelLabel: 'Max',
    name: 'Member One',
    firstName: 'Member',
    lastName: 'One',
    photoUrl: 'https://lh3.googleusercontent.com/a/member',
    role: 'Admin',
    usage: {
      date: new Date().toISOString().slice(0, 10),
      viewsLimit: 50,
      viewsUsed: 0,
      viewsRemaining: 50,
      downloadsLimit: 20,
      downloadsUsed: 0,
      downloadsRemaining: 20,
      asksLimit: 40,
      asksUsed: 0,
      asksRemaining: 40,
    },
  });
});

await check('a row missing profile columns is backfilled and keeps its level', async () => {
  const token = mintToken(googleClaims('pro@example.com', 'Pro', 'Two', 'https://lh3.googleusercontent.com/a/pro'));
  const { status, body } = await request('/api/me', token);
  assert.equal(status, 200);
  assert.equal(body.level, 'pro', 'Pro must be preserved');
  assert.equal(body.firstName, 'Pro');
  const patch = writes.find((write) => write.method === 'PATCH' && write.fields['First name'] === 'Pro');
  assert.ok(patch, 'the missing profile columns must be written back');
  assert.equal(patch.fields['Last name'], 'Two');
  assert.equal(patch.fields.Photo, 'https://lh3.googleusercontent.com/a/pro');
  assert.equal(patch.fields.Level, undefined, 'an existing level must not be downgraded');
});

await check('a first-time Google user joins as an active Basic member', async () => {
  const token = mintToken(
    googleClaims('stranger@example.com', 'Stranger', 'Person', 'https://lh3.googleusercontent.com/a/stranger'),
  );
  const { status, body } = await request('/api/me', token);
  assert.equal(status, 200);
  assert.equal(body.member, true);
  assert.equal(body.level, 'basic');
  assert.equal(body.levelLabel, 'Basic');
  assert.equal(body.firstName, 'Stranger');
  assert.equal(body.lastName, 'Person');
  assert.equal(body.photoUrl, 'https://lh3.googleusercontent.com/a/stranger');

  const created = writes.find((write) => write.method === 'POST' && write.fields.Email === 'stranger@example.com');
  assert.ok(created, 'the new member must be written to the Members table');
  assert.equal(created.fields.Level, 'Basic');
  assert.equal(created.fields.Status, 'Active');
  assert.equal(created.fields['First name'], 'Stranger');
  assert.equal(created.fields['Last name'], 'Person');
  assert.equal(created.fields.Photo, 'https://lh3.googleusercontent.com/a/stranger');
  assert.equal(created.fields.Name, 'Stranger Person');
});

await check('the newly joined member can read the library', async () => {
  const token = mintToken(googleClaims('stranger@example.com', 'Stranger', 'Person', ''));
  const { status, body } = await request('/api/methods', token);
  assert.equal(status, 200);
  assert.equal(body.methods.length, 1);
});

await check('a joined member does not get a second row', async () => {
  const before = writes.filter((write) => write.method === 'POST').length;
  const token = mintToken(googleClaims('stranger@example.com', 'Stranger', 'Person', ''));
  await request('/api/me', token);
  const after = writes.filter((write) => write.method === 'POST').length;
  assert.equal(after, before, 'repeated sign-ins must not duplicate the member');
});

await check('revoked and pending members are refused without being re-created', async () => {
  for (const email of ['revoked@example.com', 'pending@example.com']) {
    const { status, body } = await request('/api/methods', mintToken({ email }));
    assert.equal(status, 403, `${email} should be refused`);
    assert.equal(body.error, 'not_a_member');
  }
  const recreated = writes.some(
    (write) => write.method === 'POST' && ['revoked@example.com', 'pending@example.com'].includes(write.fields.Email),
  );
  assert.equal(recreated, false, 'an inactive row must not be re-created as Basic');
});

await check('a token without data.records:write gets a readable error', async () => {
  const token = mintToken(googleClaims('nowrite@example.com', 'No', 'Write', ''));
  const { status, body } = await request('/api/me', token);
  assert.equal(status, 502);
  assert.equal(body.error, 'airtable_write_error');
  assert.ok(body.message.includes('data.records:write'), body.message);
});

await check('member token streams the PDF through the proxy', async () => {
  const response = await handle(
    new Request(`${base}/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length === PDF_BYTES.length && bytes.equals(PDF_BYTES), 'PDF bytes must pass through');
});

await check('HEAD returns headers without a body', async () => {
  const response = await handle(
    new Request(`${base}/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${memberToken}` },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

await check('an inactive member cannot download a PDF', async () => {
  const { status } = await request(
    '/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001',
    mintToken({ email: 'revoked@example.com' }),
  );
  assert.equal(status, 403);
});

await check('unauthenticated PDF download is rejected', async () => {
  const { status } = await request('/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001');
  assert.equal(status, 401);
});

await check('unknown tables/records and methods are rejected', async () => {
  const foreignTable = await request('/api/files/Secret/recAAAAAAAAAAAAAA/attPDF00000000001', memberToken);
  assert.equal(foreignTable.status, 404);
  const badRecord = await request('/api/files/ISO/..%2Fetc/attPDF00000000001', memberToken);
  assert.ok(badRecord.status === 400 || badRecord.status === 404);
  const post = await handle(new Request(`${base}/api/methods`, { method: 'POST' }));
  assert.equal(post.status, 405);
  const unknown = await request('/nope', memberToken);
  assert.equal(unknown.status, 404);
});

await check('missing configuration fails closed', async () => {
  const unconfigured = createProxy({ env: { ...env, AIRTABLE_TOKEN: '' } });
  const { status, body } = await (async () => {
    const response = await unconfigured(new Request(`${base}/api/methods`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    }));
    return { status: response.status, body: await response.json() };
  })();
  assert.equal(status, 500);
  assert.equal(body.error, 'server_misconfigured');
});

await check('no Airtable token or attachment URL appears in responses', async () => {
  const { body } = await request('/api/methods', memberToken);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('test-airtable-token'), false);
  assert.equal(serialized.includes(origin), false);
});

await check('a Basic member gets 5 PDF views a day, then 429', async () => {
  const token = mintToken({ email: 'stranger@example.com' });
  for (let index = 0; index < 5; index += 1) {
    const response = await handle(
      new Request(`${base}/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001?mode=view`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    assert.equal(response.status, 200, `view ${index + 1} of 5 must be allowed`);
    assert.equal(response.headers.get('x-quota-views-used'), String(index + 1));
    await response.arrayBuffer();
  }
  const blocked = await request('/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001?mode=view', token);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'quota_exceeded');
  assert.equal(blocked.body.usage.viewsRemaining, 0);
  assert.ok(blocked.body.message.includes('5 Basic'), blocked.body.message);
});

await check('Basic members cannot download PDFs', async () => {
  const token = mintToken({ email: 'stranger@example.com' });
  const denied = await request('/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001?mode=download', token);
  assert.equal(denied.status, 429);
  assert.equal(denied.body.kind, 'download');
  assert.ok(denied.body.message.includes('not included in the Basic plan'), denied.body.message);
});

await check('Pro members can download 5 PDFs a day, then 429', async () => {
  const token = mintToken(googleClaims('pro@example.com', 'Pro', 'Two', ''));
  for (let index = 0; index < 5; index += 1) {
    const response = await handle(
      new Request(`${base}/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001?mode=download`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    assert.equal(response.status, 200, `download ${index + 1} of 5 must be allowed`);
    assert.ok(
      String(response.headers.get('content-disposition')).startsWith('attachment'),
      'a download must be served as an attachment',
    );
    await response.arrayBuffer();
  }
  const blocked = await request('/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001?mode=download', token);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.usage.downloadsRemaining, 0);
  const me = await request('/api/me', token);
  assert.equal(me.body.usage.viewsUsed, 0, 'downloads must not use up views');
  assert.equal(me.body.usage.downloadsUsed, 5);
});

await check('printing spends one download but sends no PDF again', async () => {
  seedMember('printer@example.com', { Name: 'Print Me', Status: 'Active', Level: 'Pro' });
  const token = mintToken(googleClaims('printer@example.com', 'Print', 'Me', ''));
  const response = await handle(
    new Request(`${base}/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001?mode=print`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(response.status, 204, 'printing must not stream the PDF');
  assert.equal(response.headers.get('x-quota-downloads-used'), '1');
  assert.equal(response.headers.get('x-quota-views-used'), '0', 'printing must not spend a view');
  await response.arrayBuffer();
  const me = await request('/api/me', token);
  assert.equal(me.body.usage.downloadsUsed, 1);
});

await check('counters from an earlier day reset at 00:00 UTC', async () => {
  seedMember('reset@example.com', {
    Name: 'Reset Me',
    Status: 'Active',
    Level: 'Basic',
    'Usage date': '2020-01-01',
    'Views today': 99,
    'Downloads today': 99,
  });
  const token = mintToken({ email: 'reset@example.com' });
  const viewed = await handle(
    new Request(`${base}/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(viewed.status, 200, "yesterday's usage must not count against today");
  await viewed.arrayBuffer();
  const me = await request('/api/me', token);
  assert.equal(me.body.usage.viewsUsed, 1);
  assert.equal(me.body.usage.viewsRemaining, 4);
});

await check('a HEAD probe does not use a view', async () => {
  const token = mintToken({ email: 'reset@example.com' });
  const before = await request('/api/me', token);
  const head = await handle(
    new Request(`${base}/api/files/ISO/recAAAAAAAAAAAAAA/attPDF00000000001`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(head.status, 200);
  const after = await request('/api/me', token);
  assert.equal(after.body.usage.viewsUsed, before.body.usage.viewsUsed);
});

// ---------------------------------------------------------------------------
// Push notifications + admin console
// ---------------------------------------------------------------------------

const DEVICE_TOKEN = `fcm-device-token:${'d'.repeat(140)}`;
const adminToken = mintToken({ email: 'member@example.com' });

async function call(path, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await handle(
    new Request(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

await check('a device token is stored on the member row whole, so it can be delivered to', async () => {
  const { status, body } = await call('/api/notifications/register', {
    token: memberToken,
    method: 'POST',
    body: { token: DEVICE_TOKEN, appId: 'com.bdx.texlab' },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const row = members.get('member@example.com');
  assert.equal(row.fields['FCM token'], DEVICE_TOKEN);
  assert.equal(row.fields['FCM registered'], 'Yes');
  assert.equal(row.fields['FCM app id'], 'com.bdx.texlab');
});

await check('a malformed device token is refused', async () => {
  const { status, body } = await call('/api/notifications/register', {
    token: memberToken,
    method: 'POST',
    body: { token: 'short' },
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_fcm_token');
});

await check('a member sees only a preview of their own device token', async () => {
  const { status, body } = await call('/api/notifications/me', { token: memberToken });
  assert.equal(status, 200);
  assert.equal(body.registered, true);
  assert.ok(body.fcmToken.endsWith('…'));
  assert.ok(!body.fcmToken.includes(DEVICE_TOKEN.slice(20)), 'the full token must never be returned');
});

await check('the admin console lists members with their push state', async () => {
  const { status, body } = await call('/api/admin/members', { token: adminToken });
  assert.equal(status, 200);
  const row = body.members.find((entry) => entry.email === 'member@example.com');
  assert.ok(row, 'the admin row must be listed');
  assert.equal(row.fcmRegistered, true);
  assert.equal(row.role, 'Admin');
  assert.ok(!JSON.stringify(body).includes(DEVICE_TOKEN), 'no device token may appear in the list');
});

await check('the admin console shows who is active and when the rest were last seen', async () => {
  await request('/api/me', memberToken);
  const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  members.get('pro@example.com').fields['Last active'] = stale;

  const { body } = await call('/api/admin/members', { token: adminToken });
  const active = body.members.find((entry) => entry.email === 'member@example.com');
  assert.equal(active.online, true, 'a member who just called the API must be online');
  assert.ok(active.lastActiveAt, 'the last active timestamp must be returned');
  assert.ok(
    Math.abs(Date.parse(active.lastActiveAt) - Date.now()) < 60 * 1000,
    'the timestamp must be the time of the request',
  );

  const away = body.members.find((entry) => entry.email === 'pro@example.com');
  assert.equal(away.online, false, 'a stale timestamp must not light the dot');
  assert.equal(away.lastActiveAt, stale, 'the stored time must be returned as it is');
  assert.equal(
    members.get('member@example.com').fields['Last active'],
    active.lastActiveAt,
    'the Worker must record activity on the member row',
  );

  // A second request inside the write window must not spend another Airtable write.
  await request('/api/me', memberToken);
  assert.equal(
    members.get('member@example.com').fields['Last active'],
    active.lastActiveAt,
    'activity must not be rewritten on every request',
  );
});

await check('recording activity is handed to the execution context', async () => {
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  members.get('member@example.com').fields['Last active'] = stale;
  const scheduled = [];
  const response = await handle(
    new Request(`${base}/api/me`, { headers: { Authorization: `Bearer ${memberToken}` } }),
    { waitUntil: (promise) => scheduled.push(promise) },
  );
  assert.equal(response.status, 200);
  assert.equal(scheduled.length, 1, 'the presence write goes through waitUntil');
  await Promise.all(scheduled);
  assert.notEqual(
    members.get('member@example.com').fields['Last active'],
    stale,
    'the deferred write still lands on the row',
  );
});

await check('a member sends an in-app report that lands in the Messages table', async () => {
  const token = mintToken({ email: 'pro@example.com' });
  const { status, body } = await call('/api/messages', {
    token,
    method: 'POST',
    body: {
      kind: 'report',
      subject: 'PDF will not open',
      message: 'The viewer shows a blank page on Android 14.',
      appVersion: '1.12 (4)',
      device: 'Google Pixel 8 · Android 14',
    },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const stored = [...messages.values()].at(-1).fields;
  assert.equal(stored.Email, 'pro@example.com', 'the author comes from the verified token');
  assert.equal(stored.Kind, 'Report');
  assert.equal(stored.Subject, 'PDF will not open');
  assert.equal(stored.Status, 'New');
  assert.equal(stored['App version'], '1.12 (4)');
  assert.equal(stored.Device, 'Google Pixel 8 · Android 14');
});

await check('an empty or unknown message is refused', async () => {
  const empty = await call('/api/messages', {
    token: memberToken,
    method: 'POST',
    body: { kind: 'request', message: '   ' },
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'invalid_message');
  const unknown = await call('/api/messages', {
    token: memberToken,
    method: 'POST',
    body: { kind: 'complaint', message: 'Something else entirely.' },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'invalid_kind');
});

await check('the admin console lists member messages newest first', async () => {
  const { status, body } = await call('/api/admin/messages', { token: adminToken });
  assert.equal(status, 200);
  assert.equal(body.messages.length, 1);
  const [message] = body.messages;
  assert.equal(message.kind, 'Report');
  assert.equal(message.subject, 'PDF will not open');
  assert.equal(message.email, 'pro@example.com');
  assert.equal(message.status, 'New');
});

await check('a member cannot read the message inbox', async () => {
  const token = mintToken({ email: 'pro@example.com' });
  const { status, body } = await call('/api/admin/messages', { token });
  assert.equal(status, 403);
  assert.equal(body.error, 'not_an_admin');
});

await check('a member asks about one document and gets a grounded answer', async () => {
  const { status, body } = await call('/api/documents/ask', {
    token: memberToken,
    method: 'POST',
    body: {
      methodId: 'recAAAAAAAAAAAAAA',
      question: 'What fibre mixtures does this cover?',
      history: [
        { role: 'user', text: 'Hello' },
        { role: 'model', text: 'Ask me about ISO 1833-17.' },
      ],
    },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.answer, 'ISO 1833-17 covers cellulose fibre mixtures.');
  assert.equal(body.model, 'gemini-test');
  assert.equal(body.groundedIn, 'pdf', 'the answer must be grounded in the attached PDF');
  const sent = geminiCalls.at(-1);
  assert.equal(sent.key, 'test-gemini-key', 'the Worker key must be sent as x-goog-api-key');
  assert.ok(sent.path.endsWith('/models/gemini-test:generateContent'), sent.path);
  assert.ok(sent.body.system_instruction.parts[0].text.includes('ISO 1833-17'));
  assert.ok(sent.body.system_instruction.parts[0].text.includes('Determination of cellulose fibre mixtures.'));
  assert.ok(sent.body.system_instruction.parts[0].text.includes('full PDF is attached'));
  assert.ok(
    sent.body.system_instruction.parts[0].text.includes('counterpart in the other standard: AATCC TM20A'),
    'the paired method must be described to the model',
  );
  assert.ok(
    sent.body.system_instruction.parts[0].text.includes('Quantitative fibre analysis by chemical dissolution.'),
    "the counterpart's recorded details must be in the prompt",
  );
  assert.deepEqual(
    body.comparison,
    {
      methodId: 'recCCCCCCCCCCCCCC',
      title: 'AATCC TM20A',
      name: 'Fiber Analysis: Quantitative',
      groundedIn: 'pdf',
    },
    'the response must name the counterpart it compared against',
  );
  assert.deepEqual(
    sent.body.contents.slice(0, -1).map((entry) => [entry.role, entry.parts[0].text]),
    [
      ['user', 'Hello'],
      ['model', 'Ask me about ISO 1833-17.'],
    ],
  );
  const question = sent.body.contents.at(-1);
  assert.equal(question.role, 'user');
  assert.equal(question.parts[0].inline_data.mime_type, 'application/pdf');
  assert.equal(
    question.parts[0].inline_data.data,
    Buffer.from(PDF_BYTES).toString('base64'),
    'the method PDF must be sent as inline data',
  );
  assert.equal(question.parts[1].text, 'Counterpart method document: AATCC TM20A');
  assert.equal(question.parts[2].inline_data.mime_type, 'application/pdf');
  assert.equal(
    question.parts[2].inline_data.data,
    Buffer.from(AATCC_PDF_BYTES).toString('base64'),
    "the counterpart's PDF must be sent so the two can be compared",
  );
  assert.equal(question.parts[3].text, 'What fibre mixtures does this cover?');
  assert.ok(!JSON.stringify(body).includes('test-gemini-key'), 'the key must never be returned');
});

await check('a method with no paired counterpart answers from its own document alone', async () => {
  const { status, body } = await call('/api/documents/ask', {
    token: mintToken({ email: 'pro@example.com' }),
    method: 'POST',
    body: { methodId: 'recBBBBBBBBBBBBBB', question: 'Does this method have an AATCC twin?' },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.comparison, null, 'no pair means no comparison claim');
  const sent = geminiCalls.at(-1);
  const question = sent.body.contents.at(-1);
  assert.equal(question.parts.length, 1, 'only the question is sent when no PDF can be read');
  assert.equal(question.parts[0].text, 'Does this method have an AATCC twin?');
  assert.ok(
    !sent.body.system_instruction.parts[0].text.includes('Counterpart in the library'),
    'an unpaired method must not be given a counterpart section',
  );
});

await check('the daily Ask AI allowance is charged, then refuses further questions', async () => {
  const charged = [...members.values()].find((row) => row.fields.Email === 'member@example.com');
  assert.equal(charged.fields['Ask AI today'], 1, 'one question must be charged to the row');
  assert.equal(charged.fields['Usage date'], TODAY, 'the counter must belong to today');

  const { status, body } = await call('/api/documents/ask', {
    token: mintToken({ email: 'exhausted@example.com' }),
    method: 'POST',
    body: { methodId: 'recAAAAAAAAAAAAAA', question: 'One more question?' },
  });
  assert.equal(status, 429, JSON.stringify(body));
  assert.equal(body.error, 'quota_exceeded');
  assert.equal(body.kind, 'ask');
  assert.equal(body.usage.asksRemaining, 0);
  assert.ok(body.message.includes('Ask AI'), body.message);
});

await check('a burst is held below the Gemini per-minute cap', async () => {
  const burst = createProxy({ env: { ...env, GEMINI_RPM: '1' } });
  const ask = () =>
    burst(
      new Request(`${base}/api/documents/ask`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ methodId: 'recAAAAAAAAAAAAAA', question: 'What is this?' }),
      }),
    );
  const first = await ask();
  assert.equal(first.status, 200, await first.clone().text());
  const callsBefore = geminiCalls.length;
  const second = await ask();
  const limit = await second.json();
  assert.equal(second.status, 429);
  assert.equal(limit.error, 'assistant_busy');
  assert.ok(Number(second.headers.get('retry-after')) > 0, 'a Retry-After must be sent');
  assert.equal(geminiCalls.length, callsBefore, 'a refused burst must not reach Gemini');
});

await check('a failed Gemini call gives the reserved question back', async () => {
  const row = [...members.values()].find((entry) => entry.fields.Email === 'member@example.com');
  const before = row.fields['Ask AI today'];
  const { status, body } = await call('/api/documents/ask', {
    token: memberToken,
    method: 'POST',
    body: { methodId: 'recAAAAAAAAAAAAAA', question: 'FAILME please' },
  });
  assert.equal(status, 502, JSON.stringify(body));
  assert.equal(body.error, 'gemini_error');
  assert.equal(row.fields['Ask AI today'], before, 'a failed answer costs no question');
});

await check('an empty question or an unknown method is refused', async () => {
  const empty = await call('/api/documents/ask', {
    token: memberToken,
    method: 'POST',
    body: { methodId: 'recAAAAAAAAAAAAAA', question: '  ' },
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'invalid_question');

  const badId = await call('/api/documents/ask', {
    token: memberToken,
    method: 'POST',
    body: { methodId: '../etc', question: 'What is this?' },
  });
  assert.equal(badId.status, 400);

  const get = await call('/api/documents/ask', { token: memberToken });
  assert.equal(get.status, 405);
});

await check('the document assistant needs a member token', async () => {
  const anonymous = await call('/api/documents/ask', {
    method: 'POST',
    body: { methodId: 'recAAAAAAAAAAAAAA', question: 'What is this?' },
  });
  assert.equal(anonymous.status, 401);
  const revoked = await call('/api/documents/ask', {
    token: mintToken({ email: 'revoked@example.com' }),
    method: 'POST',
    body: { methodId: 'recAAAAAAAAAAAAAA', question: 'What is this?' },
  });
  assert.equal(revoked.status, 403);
});

await check('without a Gemini key the assistant fails closed and says why', async () => {
  const { GEMINI_API_KEY, ...withoutKey } = env;
  const unconfigured = createProxy({ env: withoutKey });
  const response = await unconfigured(
    new Request(`${base}/api/documents/ask`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ methodId: 'recAAAAAAAAAAAAAA', question: 'What is this?' }),
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.error, 'gemini_not_configured');
  assert.ok(body.message.includes('GEMINI_API_KEY'), body.message);
});

await check('a non-admin member is refused the console', async () => {
  const token = mintToken({ email: 'pro@example.com' });
  const { status, body } = await call('/api/admin/members', { token });
  assert.equal(status, 403);
  assert.equal(body.error, 'not_an_admin');
});

// ---------------------------------------------------------------------------
// Admin console: one member's detail, role / membership / status edits
// ---------------------------------------------------------------------------

const editToken = mintToken({ email: 'stranger@example.com' });

async function memberRow(email) {
  const { body } = await call('/api/admin/members', { token: adminToken });
  const row = body.members.find((entry) => entry.email === email);
  assert.ok(row, `${email} must be in the list`);
  return row;
}

await check('the member list carries what the detail view shows', async () => {
  const row = await memberRow('member@example.com');
  assert.equal(row.firstName, 'Member');
  assert.equal(row.lastName, 'One');
  assert.equal(row.status, 'Active');
  assert.equal(row.levelLabel, 'Max');
  assert.equal(row.photoUrl, 'https://lh3.googleusercontent.com/a/member');
  assert.equal(row.usage.viewsLimit, 50);
  assert.equal(row.usage.downloadsLimit, 20);
});

await check('an admin edits a membership level and the member sees it at once', async () => {
  const row = await memberRow('stranger@example.com');
  const { status, body } = await call(`/api/admin/members/${row.id}`, {
    token: adminToken,
    method: 'PATCH',
    body: { level: 'pro' },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.member.level, 'pro');
  assert.equal(body.member.levelLabel, 'Pro');
  const write = writes.findLast(
    (entry) => entry.method === 'PATCH' && entry.recordId === row.id && entry.fields.Level,
  );
  assert.ok(write, 'the level must be written to the member row');
  assert.equal(write.fields.Level, 'Pro');
  const me = await request('/api/me', editToken);
  assert.equal(me.body.level, 'pro', 'the edit must not wait for the membership cache');
});

await check('an admin edits a role and the member gets it on their next request', async () => {
  const row = await memberRow('stranger@example.com');
  const { status, body } = await call(`/api/admin/members/${row.id}`, {
    token: adminToken,
    method: 'PATCH',
    body: { role: 'manager' },
  });
  assert.equal(status, 200);
  assert.equal(body.member.role, 'Manager');
  const me = await request('/api/me', editToken);
  assert.equal(me.body.role, 'Manager');
  await call(`/api/admin/members/${row.id}`, { token: adminToken, method: 'PATCH', body: { role: 'member' } });
});

await check('an unknown role, level or status is refused without writing', async () => {
  const row = await memberRow('stranger@example.com');
  const before = writes.length;
  for (const [field, value, error] of [
    ['level', 'gold', 'invalid_level'],
    ['role', 'superuser', 'invalid_role'],
    ['status', 'gone', 'invalid_status'],
  ]) {
    const { status, body } = await call(`/api/admin/members/${row.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: { [field]: value },
    });
    assert.equal(status, 400, `${field} must be validated`);
    assert.equal(body.error, error);
  }
  assert.equal(writes.length, before, 'nothing may be written for an invalid edit');
});

await check('an admin cannot demote or deactivate their own membership', async () => {
  const row = await memberRow('member@example.com');
  const demote = await call(`/api/admin/members/${row.id}`, {
    token: adminToken,
    method: 'PATCH',
    body: { role: 'member' },
  });
  assert.equal(demote.status, 400);
  assert.equal(demote.body.error, 'cannot_change_own_role');
  const deactivate = await call(`/api/admin/members/${row.id}`, {
    token: adminToken,
    method: 'PATCH',
    body: { status: 'disabled' },
  });
  assert.equal(deactivate.status, 400);
  assert.equal(deactivate.body.error, 'cannot_change_own_status');
});

await check('disabling a member blocks them, and reactivating restores access', async () => {
  const row = await memberRow('stranger@example.com');
  const disabled = await call(`/api/admin/members/${row.id}`, {
    token: adminToken,
    method: 'PATCH',
    body: { status: 'disabled' },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.member.status, 'Disabled');
  const blocked = await request('/api/methods', editToken);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'not_a_member');

  const restored = await call(`/api/admin/members/${row.id}`, {
    token: adminToken,
    method: 'PATCH',
    body: { status: 'active', level: 'basic' },
  });
  assert.equal(restored.status, 200);
  const allowed = await request('/api/methods', editToken);
  assert.equal(allowed.status, 200);
});

await check('a non-admin cannot edit a member, and an unknown row is a 404', async () => {
  const row = await memberRow('member@example.com');
  const notAdmin = await call(`/api/admin/members/${row.id}`, {
    token: mintToken({ email: 'pro@example.com' }),
    method: 'PATCH',
    body: { level: 'max' },
  });
  assert.equal(notAdmin.status, 403);
  assert.equal(notAdmin.body.error, 'not_an_admin');

  const missing = await call('/api/admin/members/recAAAAAAAAAAAAAA', {
    token: adminToken,
    method: 'PATCH',
    body: { level: 'max' },
  });
  assert.equal(missing.status, 404);
});

await check('the admin console origin may preflight, and admin responses carry the header', async () => {
  const preflight = await handle(new Request(`${base}/api/admin/members`, { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.ok(
    String(preflight.headers.get('allow')).includes('PATCH'),
    'the console edits members with PATCH',
  );
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.ok(
    String(preflight.headers.get('access-control-allow-headers')).includes('Authorization'),
    'the console sends a Bearer token',
  );
  const listed = await handle(
    new Request(`${base}/api/admin/members`, { headers: { Authorization: `Bearer ${adminToken}` } }),
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('access-control-allow-origin'), '*');
  await listed.text();
});

await check('the console reports push as unconfigured until a service account is set', async () => {
  const status = await call('/api/admin/notify', { token: adminToken });
  assert.equal(status.status, 200);
  assert.equal(status.body.fcm, false);
  const send = await call('/api/admin/notify', {
    token: adminToken,
    method: 'POST',
    body: { title: 'TexLab', body: 'Hello' },
  });
  assert.equal(send.status, 500);
  assert.equal(send.body.error, 'fcm_not_configured');
});

/**
 * The Worker fetches Google's OAuth and FCM endpoints by absolute URL, so the stub fetch answers
 * those two and forwards everything else (Airtable, the PDF) to the local server.
 */
const fcmDirect = [];
async function proxyFetch(url, init = {}) {
  const target = String(url);
  if (target === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({ access_token: 'ya29.test-access-token', expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (target.startsWith('https://fcm.googleapis.com/v1/projects/')) {
    fcmDirect.push({
      url: target,
      body: JSON.parse(init.body),
      authorization: init.headers.Authorization,
    });
    return new Response(JSON.stringify({ name: 'projects/test/messages/1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return fetch(target, init);
}

const pushHandle = createProxy({
  env: {
    ...env,
    FCM_SERVICE_ACCOUNT: JSON.stringify({
      project_id: PROJECT_ID,
      client_email: 'push@test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
  },
  fetchImpl: proxyFetch,
});

async function push(path, { token, method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await pushHandle(
    new Request(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

await check('an admin send reaches the selected device through FCM v1', async () => {
  const { status, body } = await push('/api/admin/notify', {
    token: adminToken,
    method: 'POST',
    body: { title: 'New ISO method', body: 'ISO 1833-17 was added.', targetMode: 'all members' },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.sent, 1, JSON.stringify(body));
  assert.equal(body.failed, 0);
  assert.equal(fcmDirect.length, 1);
  const message = fcmDirect[0].body.message;
  assert.equal(message.token, DEVICE_TOKEN);
  assert.equal(message.notification.title, 'New ISO method');
  assert.equal(message.notification.body, 'ISO 1833-17 was added.');
  assert.equal(fcmDirect[0].authorization, 'Bearer ya29.test-access-token');
  assert.ok(!JSON.stringify(body).includes(DEVICE_TOKEN), 'the send result must not echo the token');
});

await check('a level target does not reach other levels', async () => {
  const before = fcmDirect.length;
  const { status, body } = await push('/api/admin/notify', {
    token: adminToken,
    method: 'POST',
    body: { title: 'Pro only', body: 'For Pro members.', targetMode: 'level', targetLevel: 'pro' },
  });
  assert.equal(status, 200);
  assert.equal(body.targeted, 0, 'the only registered device is a Max member');
  assert.equal(fcmDirect.length, before);
});

await check('a suppressed email is left out of the audience', async () => {
  const { status, body } = await push('/api/admin/notify', {
    token: adminToken,
    method: 'POST',
    body: { title: 'Everyone but me', body: 'Hello', suppressedEmails: 'member@example.com' },
  });
  assert.equal(status, 200);
  assert.equal(body.targeted, 0);
});

await check('a console send without a title or body is refused', async () => {
  const { status, body } = await push('/api/admin/notify', {
    token: adminToken,
    method: 'POST',
    body: { title: '', body: '' },
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_payload');
});

await check('unregistering clears the device token', async () => {
  const cleared = await call('/api/notifications/unregister', { token: memberToken, method: 'POST' });
  assert.equal(cleared.status, 200);
  const row = members.get('member@example.com');
  assert.ok(!row.fields['FCM token'], 'the token must be cleared');
  assert.equal(row.fields['FCM registered'], 'No');
  const me = await call('/api/notifications/me', { token: memberToken });
  assert.equal(me.body.registered, false);
});

stub.close();
console.log(`\n${passed} checks passed${process.exitCode ? ', with failures' : ''}.`);
if (process.exitCode) process.exit(process.exitCode);
