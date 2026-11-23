#!/usr/bin/env node
/**
 * Textile Test Methods proxy.
 *
 * Why this exists: the Android app must not carry the Airtable token. The app talks only to
 * this server, which
 *   1. verifies the Firebase ID token from the `Authorization: Bearer <token>` header,
 *   2. checks that the token's email is an active row in the Airtable Members table,
 *   3. and only then reads the method tables / streams attachments using the Airtable token,
 *      which never leaves the server.
 *
 * So the member restriction is enforced outside the APK: an extracted token or a patched app
 * cannot read the base.
 *
 * No dependencies. Run with `node server/index.mjs` (Node 20+).
 *
 * Environment (see server/.env.example, or export them yourself):
 *   AIRTABLE_TOKEN          required, scoped data.records:read
 *   AIRTABLE_BASE_ID        required, e.g. appbl0HDJ4cbQES5h
 *   AIRTABLE_METHODS_TABLE  default "ISO,AATCC" (comma separated)
 *   AIRTABLE_MEMBERS_TABLE  default "Members"
 *   FIREBASE_PROJECT_ID     default "android-49288"
 *   PORT                    default 8080
 *   MEMBERSHIP_CACHE_SECONDS default 300
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const AIRTABLE_API = 'https://api.airtable.com/v0';

/** Membership rows with these Status values (case-insensitive) grant access. */
const ACTIVE_STATUSES = new Set([
  'active', 'approved', 'member', 'yes', 'true', '1', 'paid', 'current', 'enabled',
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Reads KEY=VALUE lines from server/.env without overwriting real environment variables. */
export function loadEnvFile(file = path.join(HERE, '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function readConfig(env = process.env) {
  const tables = String(env.AIRTABLE_METHODS_TABLE || 'ISO,AATCC')
    .split(/[,;]/)
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    port: Number(env.PORT || 8080),
    airtableToken: String(env.AIRTABLE_TOKEN || '').trim(),
    baseId: String(env.AIRTABLE_BASE_ID || '').trim(),
    methodsTables: tables,
    membersTable: String(env.AIRTABLE_MEMBERS_TABLE || 'Members').trim(),
    projectId: String(env.FIREBASE_PROJECT_ID || 'android-49288').trim(),
    membershipTtlMs: Math.max(0, Number(env.MEMBERSHIP_CACHE_SECONDS ?? 300)) * 1000,
  };
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  const message =
    error instanceof HttpError ? error.message : 'The proxy could not complete the request.';
  if (status >= 500) console.error('[proxy]', code, error?.message || error);
  sendJson(res, status, { error: code, message });
}

/** Keeps Airtable calls under its 5 requests/second limit. */
export function createThrottle(minimumIntervalMs = 210, now = Date.now) {
  let last = 0;
  let chain = Promise.resolve();
  return function throttle() {
    const wait = (async () => {
      const delay = last + minimumIntervalMs - now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      last = now();
    })();
    chain = chain.then(() => wait);
    return chain;
  };
}

// ---------------------------------------------------------------------------
// Firebase ID token verification
// ---------------------------------------------------------------------------

/** Caches Google's securetoken signing certificates, honouring Cache-Control max-age. */
export function createCertProvider({ fetchImpl = fetch, url = CERT_URL, now = Date.now } = {}) {
  let certs = null;
  let expiresAt = 0;
  let pending = null;

  async function refresh() {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Could not fetch Firebase signing keys (HTTP ${response.status}).`);
    const body = await response.json();
    const maxAge = /max-age=(\d+)/i.exec(response.headers.get('cache-control') || '')?.[1];
    certs = body;
    expiresAt = now() + (Number(maxAge) || 3600) * 1000;
    return certs;
  }

  return async function getCert(kid) {
    if (!certs || now() >= expiresAt) {
      pending ||= refresh().finally(() => {
        pending = null;
      });
      await pending;
    }
    const pem = certs?.[kid];
    return typeof pem === 'string' ? pem : null;
  };
}

/**
 * Verifies a Firebase ID token: RS256 signature against Google's certificates, issuer,
 * audience, lifetime, subject and an email claim. Returns the identity the server trusts.
 */
export async function verifyIdToken(token, { projectId, getCert, now = Date.now }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new HttpError(401, 'invalid_token', 'Malformed ID token.');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(401, 'invalid_token', 'Malformed ID token.');
  }

  if (header?.alg !== 'RS256' || typeof header?.kid !== 'string') {
    throw new HttpError(401, 'invalid_token', 'Unsupported token signing algorithm.');
  }

  const pem = await getCert(header.kid);
  if (!pem) throw new HttpError(401, 'invalid_token', 'Unknown token signing key.');

  const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  const signatureOk = verifySignature(
    'RSA-SHA256',
    signed,
    createPublicKey(pem),
    Buffer.from(encodedSignature, 'base64url'),
  );
  if (!signatureOk) throw new HttpError(401, 'invalid_token', 'Bad token signature.');

  const nowSeconds = Math.floor(now() / 1000);
  if (payload.aud !== projectId) {
    throw new HttpError(401, 'invalid_token', 'Token was issued for another project.');
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new HttpError(401, 'invalid_token', 'Token issuer does not match.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    throw new HttpError(401, 'token_expired', 'The ID token has expired. Sign in again.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSeconds + 120) {
    throw new HttpError(401, 'invalid_token', 'Token issue time is in the future.');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new HttpError(401, 'invalid_token', 'Token has no subject.');
  }
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email.includes('@')) {
    throw new HttpError(401, 'no_email', 'This account has no verified email address.');
  }
  if (payload.email_verified === false) {
    throw new HttpError(401, 'email_not_verified', 'Verify your Google email address first.');
  }

  return { uid: payload.sub, email, name: typeof payload.name === 'string' ? payload.name : '' };
}

// ---------------------------------------------------------------------------
// Airtable (server-side only)
// ---------------------------------------------------------------------------

async function airtablePage({ config, table, filterByFormula, offset, fetchImpl = fetch }) {
  const url = new URL(`${AIRTABLE_API}/${config.baseId}/${encodeURIComponent(table)}`);
  url.searchParams.set('pageSize', '100');
  if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula);
  if (offset) url.searchParams.set('offset', offset);

  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${config.airtableToken}`,
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = (() => {
      try {
        const body = JSON.parse(text);
        return body?.error?.message || body?.error?.type || '';
      } catch {
        return '';
      }
    })();
    const hint =
      response.status === 401
        ? 'Airtable rejected AIRTABLE_TOKEN.'
        : response.status === 403
          ? 'AIRTABLE_TOKEN lacks data.records:read or access to this base.'
          : response.status === 404
            ? 'Airtable base or table not found.'
            : response.status === 429
              ? 'Airtable rate limit reached.'
              : `Airtable request failed (HTTP ${response.status}).`;
    throw new HttpError(502, 'airtable_error', detail ? `${hint} ${detail}` : hint);
  }
  try {
    const body = JSON.parse(text);
    return { records: Array.isArray(body.records) ? body.records : [], offset: body.offset || null };
  } catch {
    throw new HttpError(502, 'airtable_error', 'Airtable returned an unexpected response.');
  }
}

export async function airtableList({
  config,
  table,
  filterByFormula,
  maxRecords = 1000,
  fetchImpl = fetch,
  throttle = createThrottle(),
}) {
  const records = [];
  let offset;
  do {
    await throttle();
    const page = await airtablePage({ config, table, filterByFormula, offset, fetchImpl });
    records.push(...page.records);
    offset = page.offset;
  } while (offset && records.length < maxRecords);
  return records;
}

export async function airtableRecord({ config, table, recordId, fetchImpl = fetch, throttle = createThrottle() }) {
  await throttle();
  const url = new URL(
    `${AIRTABLE_API}/${config.baseId}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`,
  );
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${config.airtableToken}`, Accept: 'application/json' },
  });
  if (response.status === 404) throw new HttpError(404, 'not_found', 'That method no longer exists.');
  if (!response.ok) throw new HttpError(502, 'airtable_error', `Airtable request failed (HTTP ${response.status}).`);
  return response.json();
}

function firstString(fields, keys) {
  for (const key of keys) {
    const value = fields?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function findAttachments(fields) {
  const known = ['PDF', 'Pdf', 'File', 'Files', 'Document', 'Documents', 'Attachment', 'Attachments'];
  const looksLikeAttachment = (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item && typeof item === 'object' && typeof item.url === 'string' && item.url);
  for (const key of known) if (looksLikeAttachment(fields?.[key])) return fields[key];
  for (const value of Object.values(fields || {})) if (looksLikeAttachment(value)) return value;
  return [];
}

function mapMethod(record, table) {
  const fields = record.fields || {};
  const attachment = findAttachments(fields)[0] || null;
  return {
    id: String(record.id || ''),
    title:
      firstString(fields, ['Name', 'Title', 'Method', 'Method Name']) ||
      String(attachment?.filename || '').replace(/\.[^.]*$/, '') ||
      'Untitled method',
    code: firstString(fields, ['Code', 'Method Code', 'Ref', 'Reference']),
    category: firstString(fields, ['Category', 'Type', 'Group']) || table,
    summary: firstString(fields, ['Summary', 'Description', 'Scope']),
    standard: firstString(fields, ['Standard', 'Test Standard', 'Standard Reference']),
    pdf: attachment
      ? {
          id: String(attachment.id || ''),
          filename: attachment.filename || null,
          size: typeof attachment.size === 'number' ? attachment.size : null,
          type: attachment.type || null,
          url: `/api/files/${encodeURIComponent(table)}/${encodeURIComponent(record.id)}/${encodeURIComponent(attachment.id || '')}`,
        }
      : null,
  };
}

function isActiveMember(record) {
  const fields = record?.fields || {};
  const status = firstString(fields, ['Status', 'Member Status', 'Active']).toLowerCase();
  if (!status) return true; // a row without a Status column is the allowlist itself
  return ACTIVE_STATUSES.has(status);
}

function escapeFormulaValue(value) {
  return value.replace(/\\/g, '').replace(/'/g, '');
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

export function createProxyServer(options) {
  const {
    config,
    fetchImpl = fetch,
    getCert = createCertProvider({ fetchImpl }),
    now = Date.now,
    throttle = createThrottle(),
  } = options;

  const membershipCache = new Map(); // email -> { expiresAt, value }

  async function membershipFor(email) {
    const cached = membershipCache.get(email);
    if (cached && cached.expiresAt > now()) return cached.value;

    const records = await airtableList({
      config,
      table: config.membersTable,
      filterByFormula: `LOWER({Email})='${escapeFormulaValue(email)}'`,
      maxRecords: 10,
      fetchImpl,
      throttle,
    });
    const match = records.find(isActiveMember);
    const value = match
      ? {
          member: true,
          name: firstString(match.fields || {}, ['Name', 'Full Name', 'Member']) || email.split('@')[0],
          role: firstString(match.fields || {}, ['Role', 'Access', 'Level']) || 'Member',
        }
      : { member: false, name: null, role: null };
    membershipCache.set(email, { expiresAt: now() + config.membershipTtlMs, value });
    return value;
  }

  async function identityFrom(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      throw new HttpError(401, 'missing_token', 'Sign in to use the method library.');
    }
    return verifyIdToken(match[1].trim(), { projectId: config.projectId, getCert, now });
  }

  async function requireMember(req) {
    const identity = await identityFrom(req);
    const membership = await membershipFor(identity.email);
    if (!membership.member) {
      throw new HttpError(403, 'not_a_member', 'This Google account is not on the laboratory member list.');
    }
    return { identity, membership };
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://proxy.local');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, HEAD, OPTIONS' });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', 'Only GET is supported.');
    }

    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/me') {
      const { membership } = await requireMember(req);
      sendJson(res, 200, membership, { Vary: 'Authorization' });
      return;
    }

    if (url.pathname === '/api/methods') {
      await requireMember(req);
      const records = [];
      for (const table of config.methodsTables) {
        const page = await airtableList({ config, table, fetchImpl, throttle });
        for (const record of page) records.push(mapMethod(record, table));
      }
      const seen = new Set();
      const methods = records
        .filter((method) => {
          if (!method.id || !method.title || seen.has(method.id)) return false;
          seen.add(method.id);
          return true;
        })
        .sort(
          (a, b) =>
            (a.category || '~').localeCompare(b.category || '~', 'en', { sensitivity: 'base' }) ||
            a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }),
        );
      sendJson(res, 200, { methods }, { Vary: 'Authorization' });
      return;
    }

    const fileMatch = /^\/api\/files\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (fileMatch) {
      await requireMember(req);
      const table = decodeURIComponent(fileMatch[1]);
      const recordId = decodeURIComponent(fileMatch[2]);
      const attachmentId = decodeURIComponent(fileMatch[3]);

      if (!config.methodsTables.includes(table)) {
        throw new HttpError(404, 'not_found', 'Unknown method table.');
      }
      if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
        throw new HttpError(400, 'bad_request', 'Invalid record id.');
      }

      const record = await airtableRecord({ config, table, recordId, fetchImpl, throttle });
      const attachment = findAttachments(record?.fields || {}).find(
        (item) => String(item.id || '') === attachmentId,
      );
      if (!attachment) throw new HttpError(404, 'not_found', 'That PDF is no longer attached.');

      const upstream = await fetchImpl(attachment.url);
      if (!upstream.ok || !upstream.body) {
        throw new HttpError(502, 'attachment_error', `Could not fetch the PDF (HTTP ${upstream.status}).`);
      }
      const headers = {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename="${String(attachment.filename || 'method.pdf').replace(/"/g, '')}"`,
        Vary: 'Authorization',
      };
      const length = upstream.headers.get('content-length');
      if (length) headers['Content-Length'] = length;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      Readable.fromWeb(upstream.body)
        .on('error', (error) => {
          console.error('[proxy] attachment stream failed:', error.message);
          res.destroy(error);
        })
        .pipe(res);
      return;
    }

    throw new HttpError(404, 'not_found', 'Unknown endpoint.');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, error);
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  loadEnvFile();
  const config = readConfig();
  const missing = [];
  if (!config.airtableToken) missing.push('AIRTABLE_TOKEN');
  if (!config.baseId) missing.push('AIRTABLE_BASE_ID');
  if (config.methodsTables.length === 0) missing.push('AIRTABLE_METHODS_TABLE');
  if (missing.length) {
    console.error(`Missing configuration: ${missing.join(', ')}. See server/.env.example.`);
    process.exit(1);
  }

  const server = createProxyServer({ config });
  server.listen(config.port, '0.0.0.0', () => {
    console.log(
      `Textile Test Methods proxy listening on :${config.port} ` +
        `(base ${config.baseId}, tables ${config.methodsTables.join(',')}, project ${config.projectId})`,
    );
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
