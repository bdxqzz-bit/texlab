/**
 * Textile Test Methods proxy — Cloudflare Worker edition of server/index.mjs.
 *
 * Why this exists: the Android app must not carry the Airtable token. The app talks only to
 * this Worker, which
 *   1. verifies the Firebase ID token from the `Authorization: Bearer <token>` header,
 *   2. looks the token's email up in the Airtable Members table and applies membership levels
 *      (Basic, Pro, Max),
 *   3. joins a first-time Google account automatically as an active **Basic** member, writing the
 *      name, first/last name, profile photo and email from the verified token to that table,
 *   4. applies the level's daily allowance (Basic 5 views, Pro 20 views + 5 downloads, Max 50
 *      views + 20 downloads) from the counters on that member row, charged per PDF opened or
 *      saved, resetting at 00:00 UTC,
 *   5. sends push notifications (Firebase FCM) to opted-in members through a recent Firebase
 *      server authentication token, and exposes a paginated member list / send tool for an admin
 *      console, and
 *   6. only then reads the method tables / streams attachments using the Airtable token, which
 *      exists only as a Worker secret.
 *
 * So the member restriction is enforced outside the APK: an extracted token or a patched app
 * cannot read the base.
 *
 * No dependencies, no Node built-ins: WebCrypto for RS256 and Google's JWKS endpoint for the
 * signing keys, plus a signed HTTPS fetch to Google's FCM v1 send endpoint. It runs on the
 * Workers free tier.
 *
 * Configuration (Worker secrets / vars):
 *   AIRTABLE_TOKEN           required secret, scoped data.records:read,data.records:write
 *                            (write is only used to add/update member rows)
 *   AIRTABLE_BASE_ID         required, e.g. appbl0HDJ4cbQES5h
 *   AIRTABLE_METHODS_TABLE   default "ISO,AATCC" (comma separated)
 *   AIRTABLE_MEMBERS_TABLE   default "Members"
 *   FIREBASE_PROJECT_ID      default "android-49288"
 *   MEMBERSHIP_CACHE_SECONDS default 300
 *   GOOGLE_JWKS_URL          default Google's securetoken JWKS (override only for tests)
 *   AIRTABLE_API_BASE        default https://api.airtable.com/v0 (override only for tests)
 *   FCM_SERVICE_ACCOUNT      secret, the whole Firebase service-account JSON (project_id,
 *                            client_email, private_key). FCM_CLIENT_EMAIL + FCM_PRIVATE_KEY are
 *                            also accepted instead. The Worker signs its own short-lived OAuth
 *                            token from these, so no FCM credential reaches the APK or console.
 *   ADMIN_ORIGIN             origin allowed to call /api/admin/* from a browser, default "*"
 *                            (the console authenticates with a Bearer ID token, not cookies)
 *   MAX_NOTIFICATIONS_PER_SEND default "100" (safety cap on one admin send)
 *   NOTIFICATIONS_TABLE       default "Notifications" (Airtable table that stores the message
 *                            drafts admins create; one row = one notification payload)
 *   MESSAGES_TABLE            default "Messages" (Airtable table where members' in-app reports
 *                            and requests are stored for the admin console)
 *   APP_VERSION_CODE         newest Android build as published, default "2" (the versionCode in
 *                            app/build.gradle.kts). `/api/app/latest` serves this to installed
 *                            apps, which offer an update when their own versionCode is lower.
 *   APP_VERSION_NAME         default "1.1" (shown in the update prompt)
 *   APP_MIN_SUPPORTED        lowest versionCode that may keep running, default "1". Raise it to
 *                            force every older install onto the new build.
 *   APP_APK_URL              public https URL of the signed APK the app downloads. Empty means
 *                            the update route answers but no update is offered.
 *   APP_RELEASE_NOTES        default "" (short "what's new" shown in the prompt)
 */

/**
 * Firebase project expected by this Worker. The app holds no server token; the Worker mints its
 * own short-lived FCM access token from a service-account JWT, so the FCM API key never appears
 * in the APK or in the console.
 */
export const FIREBASE_PROJECT_ID = 'android-49288';

const DEFAULT_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const DEFAULT_AIRTABLE_API = 'https://api.airtable.com/v0';
export const FCM_SEND_URL =
  'https://fcm.googleapis.com/v1/projects/{projectId}/messages:send';

/** Membership rows with these Status values (case-insensitive) grant access. */
const ACTIVE_STATUSES = new Set([
  'active', 'approved', 'member', 'yes', 'true', '1', 'paid', 'current', 'enabled',
]);

/** Membership levels, lowest first. Self sign-up starts at `basic`. */
export const LEVELS = ['basic', 'pro', 'max'];

/** Any value that is not pro/max (including an empty column) reads as Basic. */
export function normaliseLevel(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return LEVELS.includes(raw) ? raw : 'basic';
}

/**
 * Daily allowances per level, enforced here (never in the APK):
 *   view     = opening a PDF in the app
 *   download = saving a copy to the phone
 * Counters live on the member's own row and reset at 00:00 UTC.
 */
export const LIMITS = {
  basic: { views: 5, downloads: 0 },
  pro: { views: 20, downloads: 5 },
  max: { views: 50, downloads: 20 },
};

/** Members-table columns holding today's usage. */
export const USAGE_FIELDS = {
  date: 'Usage date',
  views: 'Views today',
  downloads: 'Downloads today',
};

/**
 * Airtable columns on the notification/draft table that this Worker reads when an admin sends
 * from the console. The console writes these columns itself.
 */
export const NOTIFICATION_FIELDS = {
  title: 'Title',
  body: 'Body',
  targetMode: 'Target mode',
  targetLevel: 'Target level',
  suppressedEmails: 'Suppressed emails',
};

/**
 * Columns on the Messages table: one row per report or request a member sends from the app.
 * The Worker writes the row with the member's verified email, never with a client-supplied one.
 */
export const MESSAGE_FIELDS = {
  email: 'Email',
  name: 'Name',
  kind: 'Kind',
  subject: 'Subject',
  message: 'Message',
  appVersion: 'App version',
  device: 'Device',
  status: 'Status',
  submittedAt: 'Submitted at',
};

/** What a member may send. `report` and `request` are the only accepted values. */
export const MESSAGE_KINDS = { report: 'Report', request: 'Request' };

/** A new row starts here; an admin changes it in Airtable once the message is handled. */
export const MESSAGE_NEW_STATUS = 'New';

/**
 * How a notification's audience is selected. None of this flows back to the app; the app only
 * registers / unregisters device tokens and receives the push.
 */
export function notificationAudience({ members, targetMode, targetLevel, suppressedEmails }) {
  const suppressed = new Set(
    (suppressedEmails || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const mode = String(targetMode || 'all members').trim().toLowerCase();
  const levelFilter = normaliseLevel(String(targetLevel || '').trim());
  const filterByLevel = mode === 'level' || (LEVELS.includes(levelFilter) && levelFilter !== 'basic');
  return members
    .filter((member) => {
      const fields = member.fields || {};
      const email = firstString(fields, MEMBER_EMAIL_FIELDS).toLowerCase();
      if (!email || suppressed.has(email)) return false;
      if (mode === 'admin only' && !ADMIN_ROLES.has(firstString(fields, ROLE_FIELDS).toLowerCase())) {
        return false;
      }
      if (filterByLevel && normaliseLevel(firstString(fields, LEVEL_FIELDS)) !== levelFilter) return false;
      if (mode === 'opt-in only' && !fcmRegistered(fields, member)) return false;
      return true;
    })
    .map((member) => {
      const fields = member.fields || {};
      return {
        email: firstString(fields, MEMBER_EMAIL_FIELDS).toLowerCase(),
        name: firstString(fields, ['Name', 'Full Name', 'Member']),
        fcmToken: firstFcmToken(fields, member) || null,
        fcmRegistered: fcmRegistered(fields, member),
        fcmAppId: firstString(fields, ['FCM app id', 'Push app id']),
      };
    });
}

// Member-table column names, most likely first.
const LEVEL_FIELDS = ['Level', 'Membership level', 'Plan'];
const FIRST_NAME_FIELDS = ['First name', 'Firstname', 'First Name'];
const LAST_NAME_FIELDS = ['Last name', 'Lastname', 'Last Name'];
const PHOTO_FIELDS = ['Photo', 'Photo URL', 'Picture', 'Avatar'];
const ROLE_FIELDS = ['Role', 'Access'];
const FCM_FIELDS = ['FCM token', 'Push token', 'Device token'];
const MEMBER_EMAIL_FIELDS = ['Email', 'Member email', 'User email'];

const ADMIN_ROLES = new Set(['admin', 'administrator', 'owner', 'manager'].map((value) =>
  value.toLowerCase(),
));

/** Roles the console may assign, keyed by the lower-case value it sends. */
const ASSIGNABLE_ROLES = new Map([
  ['member', 'Member'],
  ['manager', 'Manager'],
  ['admin', 'Admin'],
  ['owner', 'Owner'],
]);

/** Statuses the console may assign, keyed by the lower-case value it sends. */
const ASSIGNABLE_STATUSES = new Map([
  ['active', 'Active'],
  ['pending', 'Pending'],
  ['disabled', 'Disabled'],
]);

/** The UTC calendar day the counters belong to, e.g. "2026-11-22". */
function todayKey(now = Date.now) {
  return new Date(now()).toISOString().slice(0, 10);
}

function usageNumber(fields, key) {
  const value = Number(fields?.[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Today's counters for a row, zeroed when the stored date is not today. */
export function readUsage(fields, today) {
  const stored = firstString(fields, [USAGE_FIELDS.date]);
  const sameDay = stored === today;
  return {
    date: today,
    views: sameDay ? usageNumber(fields, USAGE_FIELDS.views) : 0,
    downloads: sameDay ? usageNumber(fields, USAGE_FIELDS.downloads) : 0,
  };
}

/** What a level may do today, with the used/remaining split the app displays. */
export function usageSummary(level, usage = {}) {
  const limits = LIMITS[normaliseLevel(level)];
  const viewsUsed = Math.max(0, Math.floor(Number(usage.views) || 0));
  const downloadsUsed = Math.max(0, Math.floor(Number(usage.downloads) || 0));
  return {
    date: usage.date || null,
    viewsLimit: limits.views,
    viewsUsed,
    viewsRemaining: Math.max(0, limits.views - viewsUsed),
    downloadsLimit: limits.downloads,
    downloadsUsed,
    downloadsRemaining: Math.max(0, limits.downloads - downloadsUsed),
  };
}

/** Quota numbers mirrored into response headers so the app can update its counters. */
function quotaHeaders(level, summary) {
  return {
    'X-Quota-Level': normaliseLevel(level),
    'X-Quota-Views-Limit': String(summary.viewsLimit),
    'X-Quota-Views-Used': String(summary.viewsUsed),
    'X-Quota-Downloads-Limit': String(summary.downloadsLimit),
    'X-Quota-Downloads-Used': String(summary.downloadsUsed),
  };
}

function levelLabel(level) {
  const normalised = normaliseLevel(level);
  return normalised.charAt(0).toUpperCase() + normalised.slice(1);
}

/** 429 with a message that names the allowance and when it resets. */
function quotaError({ level, kind, summary }) {
  const label = levelLabel(level);
  let message;
  if (kind === 'download') {
    message =
      summary.downloadsLimit === 0
        ? `Downloads are not included in the ${label} plan. A Pro membership allows ${LIMITS.pro.downloads} downloads a day, Max ${LIMITS.max.downloads}.`
        : `All ${summary.downloadsLimit} ${label} downloads for today are used. Pro allows ${LIMITS.pro.downloads} a day and Max ${LIMITS.max.downloads}; the count resets at 00:00 UTC.`;
  } else {
    message = `All ${summary.viewsLimit} ${label} PDF views for today are used. Pro allows ${LIMITS.pro.views} views a day and Max ${LIMITS.max.views}; the count resets at 00:00 UTC.`;
  }
  return new HttpError(429, 'quota_exceeded', message, {
    payload: { kind, level: normaliseLevel(level), usage: summary },
    headers: quotaHeaders(level, summary),
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code, message, { payload = {}, headers = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.headers = headers;
  }
}

function positiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readConfig(env = {}) {
  const tables = String(env.AIRTABLE_METHODS_TABLE || 'ISO,AATCC')
    .split(/[,;]/)
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    airtableToken: String(env.AIRTABLE_TOKEN || '').trim(),
    baseId: String(env.AIRTABLE_BASE_ID || '').trim(),
    methodsTables: tables,
    membersTable: String(env.AIRTABLE_MEMBERS_TABLE || 'Members').trim(),
    projectId: String(env.FIREBASE_PROJECT_ID || 'android-49288').trim(),
    membershipTtlMs: Math.max(0, Number(env.MEMBERSHIP_CACHE_SECONDS ?? 300)) * 1000,
    jwksUrl: String(env.GOOGLE_JWKS_URL || DEFAULT_JWKS_URL),
    airtableApi: String(env.AIRTABLE_API_BASE || DEFAULT_AIRTABLE_API).replace(/\/+$/, ''),
    fcmServiceAccount: String(env.FCM_SERVICE_ACCOUNT || '').trim(),
    fcmClientEmail: String(env.FCM_CLIENT_EMAIL || '').trim(),
    fcmPrivateKey: String(env.FCM_PRIVATE_KEY || '').trim(),
    adminOrigin: String(env.ADMIN_ORIGIN || '*').trim(),
    maxNotificationsPerSend: String(env.MAX_NOTIFICATIONS_PER_SEND ?? '100').trim(),
    notificationsTable: String(env.NOTIFICATIONS_TABLE || 'Notifications').trim(),
    messagesTable: String(env.MESSAGES_TABLE || 'Messages').trim(),
    appVersionCode: positiveInt(env.APP_VERSION_CODE, 2),
    appVersionName: String(env.APP_VERSION_NAME || '1.1').trim(),
    appMinSupported: positiveInt(env.APP_MIN_SUPPORTED, 1),
    appApkUrl: String(env.APP_APK_URL || '').trim(),
    appReleaseNotes: String(env.APP_RELEASE_NOTES || '').trim(),
  };
}

/**
 * The service account the Worker signs its FCM access token with. Accepts the whole
 * service-account JSON or the two fields separately. The private key is never logged, never
 * returned to a client and never written to an Airtable row.
 */
export function readFcmCredentials(config = {}) {
  let json = {};
  if (config.fcmServiceAccount) {
    try {
      json = JSON.parse(config.fcmServiceAccount);
    } catch {
      json = {};
    }
  }
  const clientEmail = String(json.client_email || config.fcmClientEmail || '').trim();
  const privateKey = String(json.private_key || config.fcmPrivateKey || '')
    .replace(/\\n/g, '\n')
    .trim();
  const projectId = String(json.project_id || config.projectId || FIREBASE_PROJECT_ID).trim();
  return { clientEmail, privateKey, projectId };
}

/** True when this Worker has a usable service account, i.e. it can actually send push. */
export function fcmConfigured(config = {}) {
  const { clientEmail, privateKey } = readFcmCredentials(config);
  return Boolean(clientEmail && privateKey);
}

// ---------------------------------------------------------------------------
// Admin-authorization helper (kept explicit so both worker/selftest.mjs and the console agree)
// ---------------------------------------------------------------------------

/**
 * The admin gate (role check on top of the same Firebase ID token every endpoint needs) lives
 * inside createProxy, next to identityFrom and membershipFor, because it needs this isolate's
 * key provider and membership cache.
 */

/**
 * Lets a browser-based admin tool (for example a script or an internal dashboard) call
 * /api/admin/* from its own origin. Safe to be permissive:
 * these endpoints read a Bearer ID token from the Authorization header, never a cookie, so a page
 * cannot ride an admin's browser session.
 */
function corsHeaders(config) {
  return {
    'Access-Control-Allow-Origin': config.adminOrigin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function errorResponse(error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  const message =
    error instanceof HttpError ? error.message : 'The proxy could not complete the request.';
  if (status >= 500) console.error('[proxy]', code, error?.message || error);
  return jsonResponse(
    status,
    { error: code, message, ...(error instanceof HttpError ? error.payload : {}) },
    error instanceof HttpError ? error.headers : {},
  );
}

function base64UrlToBytes(value) {
  const normalised = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

// ---------------------------------------------------------------------------
// Firebase ID token verification
// ---------------------------------------------------------------------------

/** Caches Google's securetoken signing keys (JWKS), honouring Cache-Control max-age. */
export function createKeyProvider({ jwksUrl, fetchImpl = fetch, now = Date.now } = {}) {
  let keys = null;
  let expiresAt = 0;
  let pending = null;
  const imported = new Map(); // kid -> CryptoKey

  async function refresh() {
    const response = await fetchImpl(jwksUrl, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Could not fetch Firebase signing keys (HTTP ${response.status}).`);
    }
    const body = await response.json();
    const maxAge = Number(/max-age=(\d+)/i.exec(response.headers.get('cache-control') || '')?.[1]);
    keys = Array.isArray(body?.keys) ? body.keys : [];
    imported.clear(); // drop keys from the previous JWKS in case a kid was rotated
    expiresAt = now() + (maxAge || 3600) * 1000;
    return keys;
  }

  return async function getKey(kid) {
    if (!keys || now() >= expiresAt) {
      pending ||= refresh().finally(() => {
        pending = null;
      });
      await pending;
    }
    const jwk = (keys || []).find((candidate) => candidate && candidate.kid === kid);
    if (!jwk || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) return null;
    if (imported.has(kid)) return imported.get(kid);
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    imported.set(kid, key);
    return key;
  };
}

/**
 * Verifies a Firebase ID token: RS256 signature against Google's keys, issuer, audience,
 * lifetime, subject and an email claim. Returns the identity the Worker trusts.
 */
export async function verifyIdToken(token, { projectId, getKey, now = Date.now }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new HttpError(401, 'invalid_token', 'Malformed ID token.');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header;
  let payload;
  try {
    header = base64UrlToJson(encodedHeader);
    payload = base64UrlToJson(encodedPayload);
  } catch {
    throw new HttpError(401, 'invalid_token', 'Malformed ID token.');
  }

  if (header?.alg !== 'RS256' || typeof header?.kid !== 'string') {
    throw new HttpError(401, 'invalid_token', 'Unsupported token signing algorithm.');
  }

  const key = await getKey(header.kid);
  if (!key) throw new HttpError(401, 'invalid_token', 'Unknown token signing key.');

  let signatureOk = false;
  try {
    signatureOk = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64UrlToBytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
  } catch {
    signatureOk = false;
  }
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

  const fromName = splitFullName(payload.name);
  const firstName = claimString(payload.given_name) || fromName.firstName;
  const lastName = claimString(payload.family_name) || fromName.lastName;
  const photoUrl = /^https?:\/\//i.test(claimString(payload.picture)) ? claimString(payload.picture) : '';

  return {
    uid: payload.sub,
    email,
    name: claimString(payload.name) || [firstName, lastName].filter(Boolean).join(' '),
    firstName,
    lastName,
    photoUrl,
  };
}

function claimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** "Ada Lovelace King" -> { firstName: 'Ada', lastName: 'Lovelace King' }. */
function splitFullName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function base64UrlFromBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlFromString(value) {
  return base64UrlFromBytes(new TextEncoder().encode(value));
}

/** PKCS#8 PEM (the service account's private_key) to the DER bytes WebCrypto imports. */
function pemToDer(pem) {
  const body = String(pem || '')
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Per-isolate cache: client email -> { token, expiresAt }, so a burst of sends signs once. */
const fcmAccessTokenCache = new Map();

/**
 * A short-lived OAuth Bearer token for the FCM v1 endpoint. The Worker signs the assertion itself
 * (RS256 over the service account's key), so only the service account lives in a Worker secret and
 * nothing has to be minted by hand.
 */
export async function createFcmServerToken({
  projectId,
  clientEmail,
  privateKey,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  if (!clientEmail || !privateKey) {
    throw new HttpError(
      500,
      'fcm_not_configured',
      'Push is not configured: set the Worker secret FCM_SERVICE_ACCOUNT (the Firebase service-account JSON), or FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY.',
    );
  }

  const cached = fcmAccessTokenCache.get(clientEmail);
  if (cached && cached.expiresAt > now() + 60_000) return cached.token;

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new HttpError(500, 'fcm_not_configured', 'This runtime has no WebCrypto, so the FCM assertion cannot be signed.');

  const issuedAt = Math.floor(now() / 1000);
  const unsigned = `${base64UrlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64UrlFromString(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  )}`;

  const key = await subtle.importKey(
    'pkcs8',
    pemToDer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)),
  );
  const assertion = `${unsigned}.${base64UrlFromBytes(signature)}`;

  const body = new URLSearchParams();
  body.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  body.set('assertion', assertion);

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      502,
      'fcm_auth_error',
      `Firebase rejected the service-account assertion (HTTP ${response.status}). Check that the service account belongs to project ${projectId} and has the Firebase Cloud Messaging API enabled.`,
      { payload: { detail: text.slice(0, 300) } },
    );
  }
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  if (!json.access_token) {
    throw new HttpError(502, 'fcm_auth_error', 'Firebase returned no access token for this service account.');
  }
  const ttlMs = Math.max(60, Number(json.expires_in || 3600)) * 1000;
  fcmAccessTokenCache.set(clientEmail, { token: json.access_token, expiresAt: now() + ttlMs });
  return json.access_token;
}

/**
 * Sends one FCM v1 message to a single device. Returns the upstream send result shape, which
 * the cron path records and the selftest asserts on.
 */
export async function sendFcmMessage({
  projectId,
  accessToken,
  fcmToken,
  title,
  body,
  fcmAppId,
  icon = 'DEFAULT',
  sound = 'DEFAULT',
  data = {},
  fetchImpl = fetch,
}) {
  const url = FCM_SEND_URL.replace('{projectId}', projectId);
  const message = {
    message: {
      token: fcmToken,
      notification: {
        title,
        body,
        icon: icon === 'DEFAULT' ? undefined : icon,
        sound: sound === 'DEFAULT' ? undefined : sound,
      },
      android: {
        notification: {
          icon: icon === 'DEFAULT' ? 'drawable/ic_notification' : icon,
          sound: sound === 'DEFAULT' ? 'default' : sound,
        },
        priority: 'high',
      },
      apns: {
        payload: {
          aps: {
            sound: sound === 'DEFAULT' ? 'default' : sound,
            contentAvailable: true,
          },
        },
      },
      data: data,
      webpush: {
        fcmOptions: { link: undefined },
      },
    },
  };
  if (fcmAppId) message.message.webpush.fcmOptions = { link: undefined, icon: undefined };
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  let bodyJson = {};
  try {
    bodyJson = JSON.parse(text);
  } catch {
    bodyJson = { raw: text };
  }
  if (!response.ok) {
    const code =
      bodyJson.error?.code ||
      (typeof bodyJson.error === 'string' ? bodyJson.error : '') ||
      'fcm_send_error';
    throw new HttpError(
      502,
      code,
      `FCM send failed (${response.status}): ${bodyJson.error?.message || text}`,
      { payload: { recipient: fcmToken, code, serverResponse: bodyJson } },
    );
  }
  return bodyJson;
}

// ---------------------------------------------------------------------------
// Airtable (Worker-side only)
// ---------------------------------------------------------------------------

/** Keeps this isolate's Airtable calls under its 5 requests/second limit. */
let lastAirtableCall = 0;

export function createThrottle(minimumIntervalMs = 210, now = Date.now) {
  return async function throttle() {
    const delay = lastAirtableCall + minimumIntervalMs - now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    lastAirtableCall = now();
  };
}

async function airtablePage({ config, table, filterByFormula, offset, fetchImpl = fetch }) {
  const url = new URL(`${config.airtableApi}/${config.baseId}/${encodeURIComponent(table)}`);
  url.searchParams.set('pageSize', '100');
  if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula);
  if (offset) url.searchParams.set('offset', offset);

  const response = await fetchImpl(url.toString(), {
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
  const url = `${config.airtableApi}/${config.baseId}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${config.airtableToken}`, Accept: 'application/json' },
  });
  if (response.status === 404) throw new HttpError(404, 'not_found', 'That method no longer exists.');
  if (!response.ok) throw new HttpError(502, 'airtable_error', `Airtable request failed (HTTP ${response.status}).`);
  return response.json();
}

/** Creates (no recordId) or patches (recordId) one row. Only used for membership rows. */
async function airtableWrite({
  config,
  table,
  recordId,
  fields,
  fetchImpl = fetch,
  throttle = createThrottle(),
}) {
  await throttle();
  const suffix = recordId ? `/${encodeURIComponent(recordId)}` : '';
  const url = `${config.airtableApi}/${config.baseId}/${encodeURIComponent(table)}${suffix}`;
  const response = await fetchImpl(url, {
    method: recordId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${config.airtableToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields, typecast: true }),
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
      response.status === 401 || response.status === 403
                  ? 'AIRTABLE_TOKEN needs the data.records:write scope on the target table.'
        : response.status === 422
          ? 'Airtable rejected the membership fields; check the Members column names.'
          : `Airtable write failed (HTTP ${response.status}).`;
    throw new HttpError(502, 'airtable_write_error', detail ? `${hint} ${detail}` : hint);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstString(fields, keys) {
  for (const key of keys) {
    const value = fields?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/**
 * Find the FCM push token on a member row. It may live on the Members table itself or on a
 * separate device-token table keyed by email; this helper stays in one place so both the
 * notify path and the device-token admin helpers agree on where it lives.
 */
function firstFcmToken(fields, member) {
  const direct = firstString(fields, FCM_FIELDS);
  if (direct) return direct;
  // Keep the in-test stub symmetric with the real Airtable read path: the stub member shape
  // already carries fcmToken, fcmRegistered and fcmAppId, so honour those when a dedicated
  // column is absent.
  if (member.fcmToken) return member.fcmToken;
  return '';
}

function fcmRegistered(fields, member) {
  if (typeof fields?.Fcm_registered === 'boolean') return fields.Fcm_registered;
  const raw = firstString(fields, ['FCM registered', 'Push enabled', 'Notif enabled']);
  return raw?.toLowerCase() === 'yes' || raw?.toLowerCase() === 'true' || raw === '1' || member.fcmRegistered === true;
}

/** Thin wrapper around the mem/send shapes the app and console emit. */
function sanitiseNotificationPayload(payload) {
  const title = firstString(payload, ['title', 'Title']);
  const body = firstString(payload, ['body', 'Body']);
  if (!title && !body) throw new HttpError(400, 'invalid_payload', 'A notification needs at least a Title or a Body.');
  return {
    title: title || 'TexLab',
    body: body || '',
    icon: 'DEFAULT',
    sound: 'DEFAULT',
  };
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
    name: firstString(fields, ['Method Name', 'Name', 'Title']),
    year: firstString(fields, ['Version', 'Year', 'Edition', 'Published', 'Publication Year']),
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

// Member-table column names, most likely first.
/** The identity a member request is served with, built from the row and the token claims. */
function membershipValue(record, identity = {}) {
  const fields = record?.fields || {};
  const firstName = firstString(fields, FIRST_NAME_FIELDS) || claimString(identity.firstName);
  const lastName = firstString(fields, LAST_NAME_FIELDS) || claimString(identity.lastName);
  const name =
    firstString(fields, ['Name', 'Full Name', 'Member']) ||
    [firstName, lastName].filter(Boolean).join(' ') ||
    claimString(identity.name) ||
    String(identity.email || '').split('@')[0];
  const level = normaliseLevel(firstString(fields, LEVEL_FIELDS));
  const photoUrl = firstString(fields, PHOTO_FIELDS) || claimString(identity.photoUrl);
  return {
    member: true,
    level,
    levelLabel: level.charAt(0).toUpperCase() + level.slice(1),
    name,
    firstName,
    lastName,
    photoUrl: photoUrl || null,
    role: firstString(fields, ROLE_FIELDS) || 'Member',
  };
}

/** Fills First name / Last name / Photo / Level on a row an administrator created by hand. */
async function syncProfile({ config, record, identity, fetchImpl }) {
  const fields = record?.fields || {};
  const patch = {};
  if (!firstString(fields, LEVEL_FIELDS)) patch.Level = 'Basic';
  if (!firstString(fields, FIRST_NAME_FIELDS) && identity.firstName) {
    patch[FIRST_NAME_FIELDS[0]] = identity.firstName;
  }
  if (!firstString(fields, LAST_NAME_FIELDS) && identity.lastName) {
    patch[LAST_NAME_FIELDS[0]] = identity.lastName;
  }
  if (!firstString(fields, PHOTO_FIELDS) && identity.photoUrl) patch[PHOTO_FIELDS[0]] = identity.photoUrl;
  if (!firstString(fields, ['Name', 'Full Name', 'Member'])) {
    const full = [identity.firstName, identity.lastName].filter(Boolean).join(' ');
    if (full) patch.Name = full;
  }
  if (Object.keys(patch).length === 0) return;
  try {
    await airtableWrite({
      config,
      table: config.membersTable,
      recordId: record.id,
      fields: patch,
      fetchImpl,
      throttle: createThrottle(),
    });
  } catch (error) {
    // A read-only token must not break sign-in for an existing member.
    console.warn('[proxy] profile sync skipped:', error?.message || error);
  }
}

/** Adds a first-time Google account to the Members table as an active Basic member. */
async function joinAsBasic({ config, identity, fetchImpl }) {
  const fullName =
    [identity.firstName, identity.lastName].filter(Boolean).join(' ') ||
    claimString(identity.name) ||
    identity.email;
  const fields = {
    Name: fullName,
    Email: identity.email,
    Level: 'Basic',
    Status: 'Active',
    Role: 'Member',
  };
  if (identity.firstName) fields[FIRST_NAME_FIELDS[0]] = identity.firstName;
  if (identity.lastName) fields[LAST_NAME_FIELDS[0]] = identity.lastName;
  if (identity.photoUrl) fields[PHOTO_FIELDS[0]] = identity.photoUrl;

  const created = await airtableWrite({
    config,
    table: config.membersTable,
    fields,
    fetchImpl,
    throttle: createThrottle(),
  });
  return created && created.fields ? created : { id: created?.id || '', fields };
}

/** Per-isolate membership cache: email -> { expiresAt, value, recordId }. */
const membershipCache = new Map();

export function createProxy({ env = {}, fetchImpl = fetch, getKey, now = Date.now } = {}) {
  const config = readConfig(env);
  const keyProvider = getKey || createKeyProvider({ jwksUrl: config.jwksUrl, fetchImpl, now });

  async function membershipFor(identity) {
    const email = identity.email;
    const cached = membershipCache.get(email);
    if (cached && cached.expiresAt > now()) return cached;

    const records = await airtableList({
      config,
      table: config.membersTable,
      filterByFormula: `LOWER({Email})='${escapeFormulaValue(email)}'`,
      maxRecords: 10,
      fetchImpl,
      throttle: createThrottle(),
    });

    const active = records.find(isActiveMember);
    // A row an administrator created by hand may still miss the profile columns; fill them on the
    // first request of a cache window (it never touches an existing level or name).
    if (active) await syncProfile({ config, record: active, identity, fetchImpl });
    const recordId = String(active?.id || '');
    const value =
      active
        ? membershipValue(active, identity)
        : records.length > 0
          ? { member: false, level: null, levelLabel: null, name: null, role: 'Member', reason: 'inactive' }
          : membershipValue(await joinAsBasic({ config, identity, fetchImpl }), identity);

    const entry = { expiresAt: now() + config.membershipTtlMs, value, recordId };
    membershipCache.set(email, entry);
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Device-token registration / unregistration  (app ↔ proxy ↔ Airtable Members row)
  // ---------------------------------------------------------------------------

  /**
   * Registration uses the same Firebase ID-token gate as every other endpoint, so only a real,
   * signed-in, verified account can own a push token. An existing token for the same account is
   * replaced so a fresh install revokes the old device.
   */
  async function registerFcmToken(request) {
    const { identity, membership: member, recordId } = await requireMember(request);
    if (!recordId) {
      throw new HttpError(502, 'quota_store_error', 'This member row has no record id; push cannot be tied to an account.');
    }
    const payload = await jsonBody(request);
    const token = sanitiseFcmToken(payload?.token);
    if (!token) throw new HttpError(400, 'invalid_fcm_token', 'A Firebase device token is required.');
    const appId = (payload?.appId && String(payload.appId).trim()) || '';

    const today = todayKey(now);
    const fields = {
      [FCM_FIELDS[0]]: token,
      'FCM registered': 'Yes',
      'FCM registered at': today,
      'FCM app id': appId || null,
    };
    await airtableWrite({
      config,
      table: config.membersTable,
      recordId,
      fields,
      fetchImpl,
      throttle: createThrottle(),
    });
    return jsonResponse(200, {
      ok: true,
      email: identity.email,
      registeredAt: today,
      note: 'The token is stored against this member only; it is used solely for push notifications the member opted into from TexLab.',
    });
  }

  async function unregisterFcmToken(request) {
    const { identity, recordId } = await requireMember(request);
    if (!recordId) throw new HttpError(502, 'quota_store_error', 'This member row has no record id.');

    const fields = {
      [FCM_FIELDS[0]]: null,
      'FCM registered': 'No',
      'FCM registered at': null,
      'FCM app id': null,
    };
    await airtableWrite({
      config,
      table: config.membersTable,
      recordId,
      fields,
      fetchImpl,
      throttle: createThrottle(),
    });
    return jsonResponse(200, { ok: true, email: identity.email });
  }

  async function myPushSettings(request) {
    const { membership, recordId } = await requireMember(request);
    if (!recordId) {
      return jsonResponse(200, { fcmToken: null, registered: false, registeredAt: null, appId: null });
    }
    const record = await airtableRecord({ config, table: config.membersTable, recordId, fetchImpl, throttle: createThrottle() });
    const fields = record?.fields || {};
    return jsonResponse(200, {
      fcmToken: firstFcmToken(fields, record).slice(0, 8) + '…',
      registered: fcmRegistered(fields, record),
      registeredAt: firstString(fields, ['FCM registered at']),
      appId: firstString(fields, ['FCM app id']),
    });
  }

  // ---------------------------------------------------------------------------
  // Admin console: member list, device-token management, notification send
  // ---------------------------------------------------------------------------

  /**
   * One member as the console sees them. The same shape is returned by the list and by an edit,
   * so the app can refresh a single row without reloading everything. Null when the row has no
   * email (such a row cannot sign in, so the console has nothing to show).
   */
  function adminMemberRow(record) {
    const fields = record?.fields || {};
    const email = firstString(fields, MEMBER_EMAIL_FIELDS);
    if (!email) return null;
    const level = normaliseLevel(firstString(fields, LEVEL_FIELDS));
    return {
      id: String(record.id || ''),
      email: email.toLowerCase(),
      name: firstString(fields, ['Name', 'Full Name', 'Member']) || email.split('@')[0],
      firstName: firstString(fields, FIRST_NAME_FIELDS) || '',
      lastName: firstString(fields, LAST_NAME_FIELDS) || '',
      level,
      levelLabel: level.charAt(0).toUpperCase() + level.slice(1),
      role: firstString(fields, ROLE_FIELDS) || 'Member',
      status: firstString(fields, ['Status', 'Member Status']) || '',
      photoUrl: firstString(fields, PHOTO_FIELDS) || null,
      fcmRegistered: fcmRegistered(fields, record),
      fcmTokenPreview: firstFcmToken(fields, record).slice(0, 8) + '…',
      fcmRegisteredAt: firstString(fields, ['FCM registered at']),
      usage: usageSummary(level, readUsage(fields, todayKey(now))),
    };
  }

  async function adminMembers(request) {
    await requireAdmin(request);
    const members = await airtableList({
      config,
      table: config.membersTable,
      filterByFormula: '',
      maxRecords: 500,
      fetchImpl,
      throttle: createThrottle(),
    });
    const rows = [];
    for (const record of members) {
      const row = adminMemberRow(record);
      if (row) rows.push(row);
    }
    return jsonResponse(200, {
      members: rows,
      total: rows.length,
      note: 'This list is from Airtable, one page at a time. For large bases split the console list by status, level or role.',
    });
  }

  /**
   * PATCH /api/admin/members/:id changes one member's Role, Level or Status.
   *
   * Only the three fields the console offers are writable; everything else on the row (email,
   * Google profile, usage counters) is left alone. An admin cannot demote or deactivate their own
   * row, so the console cannot lock itself out. The membership cache entry for the edited email is
   * dropped so the change applies to that member's very next request.
   */
  async function adminUpdateMember(request, recordId) {
    const { recordId: adminRecordId } = await requireAdmin(request);
    if (!/^rec[A-Za-z0-9]{14}$/.test(String(recordId || ''))) {
      throw new HttpError(400, 'bad_request', 'A valid member record id is required.');
    }

    const payload = await jsonBody(request);
    const fields = {};

    let role = '';
    if (payload?.role !== undefined && payload?.role !== null && String(payload.role).trim() !== '') {
      const key = String(payload.role).trim().toLowerCase();
      if (!ASSIGNABLE_ROLES.has(key)) {
        throw new HttpError(400, 'invalid_role', 'Role must be Member, Manager, Admin or Owner.');
      }
      role = ASSIGNABLE_ROLES.get(key);
    }

    let level = '';
    if (payload?.level !== undefined && payload?.level !== null && String(payload.level).trim() !== '') {
      const key = String(payload.level).trim().toLowerCase();
      if (!LEVELS.includes(key)) {
        throw new HttpError(400, 'invalid_level', 'Level must be Basic, Pro or Max.');
      }
      level = key;
    }

    let status = '';
    if (payload?.status !== undefined && payload?.status !== null && String(payload.status).trim() !== '') {
      const key = String(payload.status).trim().toLowerCase();
      if (!ASSIGNABLE_STATUSES.has(key)) {
        throw new HttpError(400, 'invalid_status', 'Status must be Active, Pending or Disabled.');
      }
      status = ASSIGNABLE_STATUSES.get(key);
    }

    if (!role && !level && !status) {
      throw new HttpError(400, 'invalid_payload', 'Send a role, a level or a status to change.');
    }

    const existing = await airtableRecord({
      config,
      table: config.membersTable,
      recordId,
      fetchImpl,
      throttle: createThrottle(),
    });
    const current = existing?.fields || {};

    // Self-protection: an admin editing their own row may raise their level but must keep both
    // their admin role and an active status, otherwise nobody could reopen the console.
    if (String(recordId) === String(adminRecordId)) {
      if (role && !ADMIN_ROLES.has(role.toLowerCase())) {
        throw new HttpError(
          400,
          'cannot_change_own_role',
          'You cannot remove your own admin role. Ask another admin to change it.',
        );
      }
      if (status && status !== 'Active') {
        throw new HttpError(
          400,
          'cannot_change_own_status',
          'You cannot deactivate your own membership. Ask another admin to do it.',
        );
      }
    }

    // Write the column the row actually uses (older bases name these differently).
    const column = (keys) => keys.find((key) => key in current) || keys[0];
    if (role) fields[column(ROLE_FIELDS)] = role;
    if (level) fields[column(LEVEL_FIELDS)] = level.charAt(0).toUpperCase() + level.slice(1);
    if (status) fields[column(['Status', 'Member Status'])] = status;

    await airtableWrite({
      config,
      table: config.membersTable,
      recordId,
      fields,
      fetchImpl,
      throttle: createThrottle(),
    });

    const email = firstString(current, MEMBER_EMAIL_FIELDS).toLowerCase();
    if (email) membershipCache.delete(email);

    const row = adminMemberRow({ id: recordId, fields: { ...current, ...fields } });
    return jsonResponse(200, { ok: true, member: row });
  }

  async function adminRegisterTokenForMember(request, recordId) {
    await requireAdmin(request);
    if (!recordId || !/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
      throw new HttpError(400, 'bad_request', 'A valid member record id is required.');
    }
    const payload = await jsonBody(request);
    const token = sanitiseFcmToken(payload?.token);
    if (!token) throw new HttpError(400, 'invalid_fcm_token', 'A Firebase device token is required.');
    const appId = (payload?.appId && String(payload.appId).trim()) || '';

    const today = todayKey(now);
    await airtableWrite({
      config,
      table: config.membersTable,
      recordId,
      fields: {
        [FCM_FIELDS[0]]: token,
        'FCM registered': 'Yes',
        'FCM registered at': today,
        'FCM app id': appId || null,
      },
      fetchImpl,
      throttle: createThrottle(),
    });
    return jsonResponse(200, { ok: true, registeredAt: today });
  }

  async function adminUnregisterTokenForMember(request, recordId) {
    await requireAdmin(request);
    if (!recordId || !/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
      throw new HttpError(400, 'bad_request', 'A valid member record id is required.');
    }
    await airtableWrite({
      config,
      table: config.membersTable,
      recordId,
      fields: {
        [FCM_FIELDS[0]]: null,
        'FCM registered': 'No',
        'FCM registered at': null,
        'FCM app id': null,
      },
      fetchImpl,
      throttle: createThrottle(),
    });
    return jsonResponse(200, { ok: true });
  }

  /**
   * POST /api/messages stores one report or request from a signed-in member.
   *
   * The author is the verified account on the ID token, not anything in the body, so a patched
   * app cannot post a message as somebody else. The message is written to the Messages table and
   * read back by the admin console; nothing is sent by email.
   */
  async function submitMessage(request) {
    const { identity, membership } = await requireMember(request);
    const payload = await jsonBody(request);

    const kind = MESSAGE_KINDS[String(payload?.kind || '').trim().toLowerCase()];
    if (!kind) {
      throw new HttpError(400, 'invalid_kind', 'Choose Report or Request.');
    }
    const message = String(payload?.message || '').trim();
    if (message.length < 5) {
      throw new HttpError(400, 'invalid_message', 'Write a short message first.');
    }
    if (message.length > 4000) {
      throw new HttpError(400, 'invalid_message', 'Keep the message under 4000 characters.');
    }
    const subject = String(payload?.subject || '').trim().slice(0, 150);
    const appVersion = String(payload?.appVersion || '').trim().slice(0, 40);
    const device = String(payload?.device || '').trim().slice(0, 120);

    const fields = {
      [MESSAGE_FIELDS.email]: identity.email.toLowerCase(),
      [MESSAGE_FIELDS.name]: String(membership?.name || identity.name || identity.email).trim(),
      [MESSAGE_FIELDS.kind]: kind,
      [MESSAGE_FIELDS.subject]: subject,
      [MESSAGE_FIELDS.message]: message,
      [MESSAGE_FIELDS.appVersion]: appVersion,
      [MESSAGE_FIELDS.device]: device,
      [MESSAGE_FIELDS.status]: MESSAGE_NEW_STATUS,
      [MESSAGE_FIELDS.submittedAt]: new Date(now()).toISOString(),
    };
    const created = await airtableWrite({
      config,
      table: config.messagesTable,
      fields,
      fetchImpl,
      throttle: createThrottle(),
    });
    return jsonResponse(200, {
      ok: true,
      id: String(created?.id || ''),
      status: MESSAGE_NEW_STATUS,
      note: 'Your message is stored for the lab administrator. Nothing is shared outside TexLab.',
    });
  }

  /** One Messages row as the admin console sees it. */
  function adminMessageRow(record) {
    const fields = record?.fields || {};
    return {
      id: String(record?.id || ''),
      email: firstString(fields, [MESSAGE_FIELDS.email, 'Member email']).toLowerCase(),
      name: firstString(fields, [MESSAGE_FIELDS.name, 'Member']),
      kind: firstString(fields, [MESSAGE_FIELDS.kind, 'Type']) || 'Report',
      subject: firstString(fields, [MESSAGE_FIELDS.subject]),
      message: firstString(fields, [MESSAGE_FIELDS.message, 'Body']),
      appVersion: firstString(fields, [MESSAGE_FIELDS.appVersion]),
      device: firstString(fields, [MESSAGE_FIELDS.device]),
      status: firstString(fields, [MESSAGE_FIELDS.status]) || MESSAGE_NEW_STATUS,
      createdAt:
        firstString(fields, [MESSAGE_FIELDS.submittedAt]) || String(record?.createdTime || ''),
    };
  }

  /**
   * GET /api/admin/messages lists the member inbox, newest first. Admin-only: the same gate as
   * every other /api/admin route, so an ordinary member cannot read other members' messages.
   */
  async function adminMessages(request) {
    await requireAdmin(request);
    const records = await airtableList({
      config,
      table: config.messagesTable,
      filterByFormula: '',
      maxRecords: 200,
      fetchImpl,
      throttle: createThrottle(),
    });
    const messages = records
      .map(adminMessageRow)
      .filter((row) => row.message || row.subject)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return jsonResponse(200, {
      messages,
      total: messages.length,
      table: config.messagesTable,
      note: 'One row per report or request. Status and replies are edited in Airtable.',
    });
  }

  /**
   * POST /api/admin/notify sends one push to the members an admin selected; GET reports whether
   * push is configured. Only an audience summary and per-recipient result codes come back — no
   * device token, key or service-account field is ever echoed.
   */
  async function adminNotify(request) {
    await requireAdmin(request);
    const credentials = readFcmCredentials(config);
    const maxPerSend = Math.max(1, Number(config.maxNotificationsPerSend ?? '100'));

    if (request.method === 'GET') {
      return jsonResponse(200, {
        status: 'ready',
        fcm: Boolean(credentials.clientEmail && credentials.privateKey),
        projectId: credentials.projectId,
        membersTable: config.membersTable,
        maxPerSend,
        targetModes: ['all members', 'opt-in only', 'admin only', 'level'],
      });
    }

    const payload = await jsonBody(request);
    const { title, body } = sanitiseNotificationPayload(payload);
    const targetMode = String(payload?.targetMode || 'all members').trim();
    const targetLevel = String(payload?.targetLevel || '').trim();
    const suppressedEmails = String(payload?.suppressedEmails || '').trim();

    const members = await airtableList({
      config,
      table: config.membersTable,
      filterByFormula: '',
      maxRecords: 500,
      fetchImpl,
      throttle: createThrottle(),
    });
    const audience = notificationAudience({ members, targetMode, targetLevel, suppressedEmails });
    const recipients = audience.filter((member) => member.fcmToken);
    const skipped = audience.filter((member) => !member.fcmToken).map((member) => member.email);

    if (recipients.length > maxPerSend) {
      throw new HttpError(
        400,
        'audience_too_large',
        `This send reaches ${recipients.length} devices; one send is capped at ${maxPerSend}. Narrow the target (mode, level or suppressed emails) or send in batches.`,
        { payload: { targeted: recipients.length, limit: maxPerSend } },
      );
    }
    if (recipients.length === 0) {
      return jsonResponse(200, {
        ok: true,
        targeted: 0,
        sent: 0,
        failed: 0,
        skipped,
        note: 'No member with a registered device matched this target.',
      });
    }

    const accessToken = await createFcmServerToken({
      projectId: credentials.projectId,
      clientEmail: credentials.clientEmail,
      privateKey: credentials.privateKey,
      fetchImpl,
      now,
    });

    let sent = 0;
    const results = [];
    for (const recipient of recipients) {
      try {
        await sendFcmMessage({
          projectId: credentials.projectId,
          accessToken,
          fcmToken: recipient.fcmToken,
          title,
          body,
          fcmAppId: recipient.fcmAppId || undefined,
          data: { type: 'texlab.notification', title, body },
          fetchImpl,
        });
        sent += 1;
        results.push({ email: recipient.email, ok: true });
      } catch (error) {
        results.push({ email: recipient.email, ok: false, error: error?.code || 'fcm_send_error' });
      }
    }
    const failed = recipients.length - sent;

    return jsonResponse(200, {
      ok: failed === 0,
      title,
      body,
      targetMode,
      targetLevel,
      targeted: recipients.length,
      sent,
      failed,
      skipped,
      results: results.slice(0, 200),
    });
  }


  /** Reads today's counters for a member row without consuming anything. */
  async function usageFor(recordId, level) {
    if (!recordId) return usageSummary(level, { date: todayKey(now), views: 0, downloads: 0 });
    const record = await airtableRecord({ config, table: config.membersTable, recordId, fetchImpl, throttle: createThrottle() });
    return usageSummary(level, readUsage((record && record.fields) || {}, todayKey(now)));
  }

  /**
   * Charges one view or download to today's counters, after checking the level's allowance.
   * Fails closed when the counters cannot be stored, so the allowance cannot be bypassed.
   */
  async function consumeQuota({ recordId, level, kind }) {
    const today = todayKey(now);
    if (!recordId) {
      // No recordId available - allow the action but don't update counters
      // This can happen for newly created members or edge cases
      // Basic level: 5 views, no downloads; Pro: 20 views + 5 downloads; Max: 50 views + 20 downloads
      const levelNorm = normaliseLevel(level);
      const limits = LIMITS[levelNorm];
      if (kind === 'download' && limits.downloads === 0) {
        throw new HttpError(429, 'quota_exceeded', `Downloads are not included in the ${levelNorm.charAt(0).toUpperCase() + levelNorm.slice(1)} plan.`);
      }
      // Allow view/download without updating counters (no row to update)
      return { level: levelNorm, usage: { date: today, views: 0, downloads: 0 }, summary: usageSummary(levelNorm, { date: today, views: 0, downloads: 0 }) };
    }
    const record = await airtableRecord({ config, table: config.membersTable, recordId, fetchImpl, throttle: createThrottle() });
    const usage = readUsage((record && record.fields) || {}, today);
    const summary = usageSummary(level, usage);
    const remaining = kind === 'download' ? summary.downloadsRemaining : summary.viewsRemaining;
    if (remaining <= 0) throw quotaError({ level, kind, summary });

    if (kind === 'download') usage.downloads += 1;
    else usage.views += 1;

    await airtableWrite({
      config,
      table: config.membersTable,
      recordId,
      fields: {
        [USAGE_FIELDS.date]: today,
        [USAGE_FIELDS.views]: usage.views,
        [USAGE_FIELDS.downloads]: usage.downloads,
      },
      fetchImpl,
      throttle: createThrottle(),
    });
    return { level: normaliseLevel(level), usage, summary: usageSummary(level, usage) };
  }

  async function identityFrom(request) {
    const header = request.headers.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      throw new HttpError(401, 'missing_token', 'Sign in to use the method library.');
    }
    return verifyIdToken(match[1].trim(), { projectId: config.projectId, getKey: keyProvider, now });
  }

  async function requireMember(request) {
    const identity = await identityFrom(request);
    const entry = await membershipFor(identity);
    if (!entry.value.member) {
      throw new HttpError(
        403,
        'not_a_member',
        'This membership is not active. An administrator must set Status to Active in the Members table.',
      );
    }
    return { identity, membership: entry.value, recordId: entry.recordId };
  }

  /**
   * The admin gate: a valid Firebase ID token whose Members row has an admin role. This is the same
   * gate the admin console uses when it forwards a signed-in administrator's ID token here.
   */
  async function requireAdmin(request) {
    const { identity, membership, recordId } = await requireMember(request);
    if (!ADMIN_ROLES.has(String(membership.role || '').toLowerCase())) {
      throw new HttpError(
        403,
        'not_an_admin',
        'Only a member whose Role is Admin / Administrator / Owner / Manager can use the console. Raise the Role on that member row in Airtable.',
      );
    }
    return { identity, membership, recordId };
  }

  async function route(request) {
    const url = new URL(request.url);
    const method = request.method || 'GET';

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { Allow: 'GET, HEAD, POST, PATCH, DELETE, OPTIONS', ...corsHeaders(config) },
      });
    }
    if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method)) {
      throw new HttpError(405, 'method_not_allowed', 'Only GET, HEAD, POST, PATCH and DELETE are supported.');
    }

    if (url.pathname === '/healthz') {
      return jsonResponse(200, {
        ok: true,
        configured: Boolean(config.airtableToken && config.baseId),
        fcm: fcmConfigured(config),
        update: Boolean(config.appApkUrl),
      });
    }

    // Public: the newest Android build, so an installed app can offer (or force) an update.
    // No token and no Airtable access — this is version metadata only, served before the
    // membership gate so a signed-out or expired install can still be told to update.
    if (url.pathname === '/api/app/latest') {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Only GET and HEAD are supported.');
      }
      return jsonResponse(
        200,
        {
          app: 'texlab',
          versionCode: config.appVersionCode,
          versionName: config.appVersionName,
          minSupported: config.appMinSupported,
          downloadUrl: config.appApkUrl,
          notes: config.appReleaseNotes,
          configured: Boolean(config.appApkUrl),
        },
        corsHeaders(config),
      );
    }

    if (!config.airtableToken || !config.baseId) {
      throw new HttpError(500, 'server_misconfigured', 'AIRTABLE_TOKEN / AIRTABLE_BASE_ID are not set.');
    }

    if (url.pathname === '/api/me') {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Only GET and HEAD are supported.');
      }
      const { membership, recordId } = await requireMember(request);
      const usage = await usageFor(recordId, membership.level);
      return jsonResponse(200, { ...membership, usage }, { Vary: 'Authorization' });
    }

    if (url.pathname === '/api/notifications/register') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Only POST is supported.');
      return registerFcmToken(request);
    }

    if (url.pathname === '/api/notifications/unregister') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Only POST is supported.');
      return unregisterFcmToken(request);
    }

    if (url.pathname === '/api/notifications/me') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Only GET is supported.');
      return myPushSettings(request);
    }

    // A member's report or request: stored in the Messages table for the admin console.
    if (url.pathname === '/api/messages') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Only POST is supported.');
      return submitMessage(request);
    }

    if (url.pathname === '/api/admin/messages') {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Only GET is supported.');
      }
      return adminMessages(request);
    }

    if (url.pathname === '/api/admin/members') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Only GET is supported.');
      return adminMembers(request);
    }

    const adminMemberMatch = /^\/api\/admin\/members\/([^/]+)$/.exec(url.pathname);
    if (adminMemberMatch) {
      if (method === 'PATCH') return adminUpdateMember(request, adminMemberMatch[1]);
      throw new HttpError(405, 'method_not_allowed', 'Use PATCH to change a member\'s role, level or status.');
    }

    const adminPushTokenMatch = /^\/api\/admin\/members\/([^/]+)\/push-token$/.exec(url.pathname);
    if (adminPushTokenMatch) {
      if (method === 'POST') return adminRegisterTokenForMember(request, adminPushTokenMatch[1]);
      if (method === 'DELETE') return adminUnregisterTokenForMember(request, adminPushTokenMatch[1]);
      throw new HttpError(405, 'method_not_allowed', 'Use POST to set a device token or DELETE to clear it.');
    }

    if (url.pathname === '/api/admin/notify') {
      if (method !== 'GET' && method !== 'POST') {
        throw new HttpError(405, 'method_not_allowed', 'Use GET for status or POST to send.');
      }
      return adminNotify(request);
    }

    if (url.pathname === '/api/methods') {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Only GET and HEAD are supported.');
      }
      await requireMember(request);
      const records = [];
      for (const table of config.methodsTables) {
        const page = await airtableList({ config, table, fetchImpl, throttle: createThrottle() });
        for (const record of page) records.push(mapMethod(record, table));
      }
      const seen = new Set();
      const methods = records
        .filter((entry) => {
          if (!entry.id || !entry.title || seen.has(entry.id)) return false;
          seen.add(entry.id);
          return true;
        })
        .sort(
          (a, b) =>
            (a.category || '~').localeCompare(b.category || '~', 'en', { sensitivity: 'base' }) ||
            a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }),
        );
      return jsonResponse(200, { methods }, { Vary: 'Authorization' });
    }

    const fileMatch = /^\/api\/files\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (fileMatch) {
      const { membership, recordId: memberRecordId } = await requireMember(request);
      // Opening (view) and saving (download) are counted separately against the daily allowance.
      const mode = url.searchParams.get('mode') === 'download' ? 'download' : 'view';
      const table = decodeURIComponent(fileMatch[1]);
      const recordId = decodeURIComponent(fileMatch[2]);
      const attachmentId = decodeURIComponent(fileMatch[3]);

      if (!config.methodsTables.includes(table)) {
        throw new HttpError(404, 'not_found', 'Unknown method table.');
      }
      if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
        throw new HttpError(400, 'bad_request', 'Invalid record id.');
      }

      const record = await airtableRecord({ config, table, recordId, fetchImpl, throttle: createThrottle() });
      const attachment = findAttachments(record?.fields || {}).find(
        (item) => String(item.id || '') === attachmentId,
      );
      if (!attachment) throw new HttpError(404, 'not_found', 'That PDF is no longer attached.');

      const upstream = await fetchImpl(attachment.url);
      if (!upstream.ok) {
        throw new HttpError(502, 'attachment_error', `Could not fetch the PDF (HTTP ${upstream.status}).`);
      }

      // Charged only once the PDF is known to be available, and never for a HEAD probe.
      const quota =
        method === 'HEAD'
          ? { summary: await usageFor(memberRecordId, membership.level) }
          : await consumeQuota({ recordId: memberRecordId, level: membership.level, kind: mode });

      const filename = String(attachment.filename || 'method.pdf').replace(/"/g, '');
      const headers = {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${mode === 'download' ? 'attachment' : 'inline'}; filename="${filename}"`,
        Vary: 'Authorization',
        ...quotaHeaders(membership.level, quota.summary),
      };
      const length = upstream.headers.get('content-length');
      if (length) headers['Content-Length'] = length;
      return new Response(method === 'HEAD' ? null : upstream.body, { status: 200, headers });
    }

    throw new HttpError(404, 'not_found', 'Unknown endpoint.');
  }

  function withAdminCors(request, response) {
    if (!new URL(request.url).pathname.startsWith('/api/admin')) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders(config))) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  }

  return async function handle(request) {
    try {
      return withAdminCors(request, await route(request));
    } catch (error) {
      return withAdminCors(request, errorResponse(error));
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers shared by the real worker and the self-test
// ---------------------------------------------------------------------------

async function jsonBody(request) {
  const method = request.method || 'GET';
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
    throw new HttpError(405, 'method_not_allowed', 'Only POST, PUT and PATCH carry a JSON body.');
  }
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

function sanitiseFcmToken(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  // A registration token has to be stored whole: a truncated one can never be delivered to.
  // Anything printed in a response is shortened at the call site instead.
  if (raw.length < 20 || raw.length > 4096) return '';
  if (!/^[A-Za-z0-9_:.\-]+$/.test(raw)) return '';
  return raw;
}

// Built once per isolate so the JWKS/membership caches survive between requests.
let cachedProxy = null;
let cachedProxyKey = '';

export default {
  async fetch(request, env) {
    try {
      const config = readConfig(env);
      const key = `${config.baseId}|${config.jwksUrl}|${config.projectId}`;
      if (!cachedProxy || cachedProxyKey !== key) {
        cachedProxy = createProxy({ env });
        cachedProxyKey = key;
      }
      return await cachedProxy(request);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
