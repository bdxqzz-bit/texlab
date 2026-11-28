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
 *   GEMINI_API_KEY           secret, Google AI Studio key for the "Ask AI" button on a method's
 *                            detail screen. `POST /api/documents/ask` sends the method's attached
 *                            PDF to Gemini as inline data, so answers are grounded in the
 *                            document itself, and charges one of the member's daily Ask AI
 *                            questions (Basic 5, Pro 20, Max 40, reset at 00:00 UTC). Without the
 *                            key that route answers 500 gemini_not_configured and the rest of the
 *                            proxy is unaffected. When the row links a counterpart method in the
 *                            other standard (Airtable `AATCC` / `ISO Counterpart`), that method's
 *                            PDF is attached too, so the answer can compare the two.
 *   GEMINI_MODEL             default "gemini-3.1-flash-lite" (any generateContent model)
 *   GEMINI_API_BASE          default https://generativelanguage.googleapis.com/v1beta
 *                            (override only for tests)
 *   GEMINI_RPM               default "10", Gemini calls one isolate may start per minute. Keeps
 *                            the free tier's requests-per-minute limit from being tripped.
 *   APP_VERSION_CODE         newest Android build as published, default "2" (the versionCode in
 *                            app/build.gradle.kts). `/api/app/latest` serves this to installed
 *                            apps, which offer an update when their own versionCode is lower.
 *   APP_VERSION_NAME         default "1.1" (shown in the update prompt)
 *   APP_MIN_SUPPORTED        lowest versionCode that may keep running, default "1". Raise it to
 *                            force every older install onto the new build.
 *   APP_APK_URL              public https URL of the signed APK the app downloads. Empty means
 *                            the update route answers but no update is offered.
 *   APP_RELEASE_NOTES        default "" (short "what's new" shown in the prompt)
 *   INVITES                  KV namespace binding that stores invitation codes and the Pro trials
 *                            they earn. Without it the proxy answers 503 invites_unavailable and
 *                            everything else keeps working.
 *   INVITE_TRIAL_DAYS        default "7" days of Pro given to both members when a code is redeemed
 */

const DEFAULT_GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Google retires older flash models for new keys; 3.1 flash-lite accepts inline PDFs and is
// available on the free tier. Override with GEMINI_MODEL if the account has another model.
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

/** Longest question the document assistant accepts, mirroring the app's input limit. */
export const DOCUMENT_QUESTION_LIMIT = 1000;

/** How many earlier chat turns are replayed to the model; the rest stay on the device. */
export const DOCUMENT_HISTORY_TURNS = 8;

/**
 * The PDF grounding budget: the Worker forwards at most this much of one attached file to Gemini,
 * keeps that copy for a few minutes because questions arrive in bursts, and remembers a handful of
 * documents per isolate.
 */
export const DOCUMENT_PDF_MAX_BYTES = 12 * 1024 * 1024;
export const DOCUMENT_PDF_CACHE_SECONDS = 600;
export const DOCUMENT_PDF_CACHE_ENTRIES = 4;

/**
 * One question can carry the method's own PDF and its counterpart's (ISO ↔ AATCC). Both go to
 * Gemini in the same inline request, so their combined base64 must stay inside the request budget.
 */
export const DOCUMENT_PAIR_MAX_BASE64 = 18 * 1024 * 1024;

/** The Airtable link columns that pair an ISO method with its AATCC counterpart and back. */
export const COUNTERPART_FIELDS = [
  'AATCC',
  'ISO Counterpart',
  'ISO',
  'Counterpart',
  'Equivalent',
  'Equivalent Method',
];

/**
 * The methods linked to a row as its counterpart in the other standard family. Airtable returns
 * linked records as arrays of record ids; a row the lab has not paired has no such column or an
 * empty array, which means "no comparison available" rather than an error.
 */
export function counterpartIds(fields = {}, limit = 2) {
  const ids = [];
  const collect = (value) => {
    for (const item of Array.isArray(value) ? value : []) {
      if (typeof item === 'string' && /^rec[A-Za-z0-9]{14}$/.test(item) && !ids.includes(item)) {
        ids.push(item);
      }
    }
  };
  for (const key of COUNTERPART_FIELDS) collect(fields?.[key]);
  // A lab that renames the column still works when the new name says what it is.
  for (const [key, value] of Object.entries(fields || {})) {
    if (COUNTERPART_FIELDS.some((name) => name.toLowerCase() === key.toLowerCase())) continue;
    if (/counterpart|equivalent/i.test(key)) collect(value);
  }
  return ids.slice(0, limit);
}

/** Gemini calls one isolate may start per minute; keeps the free tier's RPM from being tripped. */
export const DEFAULT_GEMINI_RPM = 10;

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
 *   ask      = one question to the document assistant (paid for by the lab's Gemini key)
 * Counters live on the member's own row and reset at 00:00 UTC.
 */
export const LIMITS = {
  basic: { views: 5, downloads: 0, asks: 5 },
  pro: { views: 20, downloads: 5, asks: 20 },
  max: { views: 50, downloads: 20, asks: 40 },
};

/**
 * Invitation codes: every member has one, shown under the app's ⋮ menu. A member who signs up and
 * redeems someone else's code gives **both** sides this many days of Pro. The trial is a level
 * overlay kept in KV, so no extra Airtable column is needed and an administrator's own Level is
 * never rewritten.
 */
export const INVITE_TRIAL_DAYS = 7;

/** No 0/O or 1/I, so a code read out loud or typed by hand cannot be mistyped into another one. */
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_CODE_LENGTH = 8;

/** Accepts a code however it was typed or pasted: lower case, spaces, or with a dash. */
export function normaliseInviteCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The display form, e.g. `TX4K-7Q2M`; anything else is returned unchanged. */
export function formatInviteCode(code) {
  const clean = normaliseInviteCode(code);
  return clean.length === INVITE_CODE_LENGTH ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/** A fresh random code. Randomness comes from the platform, never from a counter or the email. */
function randomInviteCode() {
  const bytes = new Uint8Array(INVITE_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const byte of bytes) code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length];
  return code;
}

/**
 * The level a member actually gets: a running invite trial lifts Basic to Pro, and never lowers a
 * Pro or Max an administrator granted.
 */
export function effectiveLevel(storedLevel, proUntilMs, nowMs = Date.now()) {
  const base = normaliseLevel(storedLevel);
  const until = Number(proUntilMs);
  if (base === 'basic' && Number.isFinite(until) && until > nowMs) return 'pro';
  return base;
}

/** Members-table columns holding today's usage. */
export const USAGE_FIELDS = {
  date: 'Usage date',
  views: 'Views today',
  downloads: 'Downloads today',
  asks: 'Ask AI today',
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
 * Columns on the method-uploads table: one row per method/document a member submits for review,
 * with the file itself in an attachment field. The Worker creates the row with the member's
 * verified email and the review columns left empty; an administrator then sets Status to
 * `Approved` and Days to 1–30, and the Worker turns that into a Pro trial on the next request.
 */
export const UPLOAD_FIELDS = {
  title: 'Title',
  email: 'Email',
  name: 'Name',
  file: 'File',
  fileName: 'File name',
  contentType: 'Content type',
  size: 'Size',
  status: 'Status',
  submittedAt: 'Submitted at',
  days: 'Days',
  proUntil: 'Pro until',
  reviewNote: 'Review note',
  // Filled by the admin console's AI review: the method's own designation, what it covers, and
  // the standard it belongs to (ISO / AATCC). Kept on the row so Airtable shows the same values
  // the console does.
  methodName: 'Method name',
  scope: 'Scope',
  standard: 'Standard',
  // `<table>/<recordId>` once an approved upload was copied into the method library.
  publishedIn: 'Published in',
};

/** A new upload starts here; an admin moves it to `Approved` (with Days) or `Rejected`. */
export const UPLOAD_NEW_STATUS = 'Pending';

/** The most one upload may carry. Airtable's attachment limit is 5 MB per file. */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** Files Airtable accepts as an attachment and a lab would actually submit. */
export const UPLOAD_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** The Pro trial an approved upload earns is between these two many days. */
export const UPLOAD_TRIAL_MIN_DAYS = 1;
export const UPLOAD_TRIAL_MAX_DAYS = 30;

/** Method columns the document assistant reads, in the order they are presented to the model. */
const DOCUMENT_CONTEXT_FIELDS = [
  'Method',
  'Method Name',
  'Name',
  'Title',
  'Scope',
  'Summary',
  'Description',
  'Standard',
  'Category',
  'Type',
  'Version',
  'Year',
  'Code',
];

/**
 * The document text an answer is grounded in, built from a method row. Only short text columns
 * are used, so attachments, comments and long notes never leave the Worker, and the result is
 * capped so one rich row cannot blow up the request.
 */
export function documentContext(fields = {}, limit = 6000) {
  const lines = [];
  const seen = new Set();
  const add = (label, value) => {
    const text = String(value || '').trim();
    if (!text || seen.has(text) || lines.length >= 40) return;
    seen.add(text);
    lines.push(`${label}: ${text}`);
  };
  for (const key of DOCUMENT_CONTEXT_FIELDS) add(key, firstString(fields, [key]));
  for (const [key, value] of Object.entries(fields || {})) {
    if (typeof value !== 'string' || value.length > 4000) continue;
    add(key, value);
  }
  return lines.join('\n').slice(0, limit);
}

/**
 * The earlier turns of a conversation, as Gemini's `contents` expects them. Anything that is not
 * a string is dropped, consecutive turns from the same side are merged, and only the most recent
 * turns are kept, so a client cannot replay an unbounded history.
 */
/**
 * Reads the JSON an AI review returns, tolerating a code fence or a sentence around it, and caps
 * every field so one surprising answer cannot write a huge value into Airtable.
 */
export function parseUploadAnalysis(text) {
  const clean = (value, max) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  const raw = String(text || '').trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let body = {};
  for (const candidate of [unfenced, unfenced.slice(unfenced.indexOf('{'), unfenced.lastIndexOf('}') + 1)]) {
    if (!candidate) continue;
    try {
      body = JSON.parse(candidate);
      break;
    } catch {
      // Try the next shape.
    }
  }
  const standard = clean(body?.standard, 40);
  return {
    methodName: clean(body?.methodName ?? body?.method_name ?? body?.name, 150),
    scope: clean(body?.scope, 2000),
    standard: /^iso$/i.test(standard) ? 'ISO' : /^aatcc$/i.test(standard) ? 'AATCC' : standard,
  };
}

export function sanitiseChatHistory(history, maxTurns = DOCUMENT_HISTORY_TURNS) {
  if (!Array.isArray(history)) return [];
  const turns = [];
  for (const entry of history) {
    const text = String(entry?.text ?? '').trim().slice(0, 2000);
    if (!text) continue;
    const role = String(entry?.role ?? '').toLowerCase() === 'model' ? 'model' : 'user';
    const previous = turns[turns.length - 1];
    if (previous && previous.role === role) previous.text = `${previous.text}\n${text}`.slice(0, 4000);
    else turns.push({ role, text });
  }
  return turns.slice(-maxTurns);
}

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
// Date a hand-granted Pro runs to. An administrator who gives Pro in the table can also give it an
// end, so the app counts down instead of reporting an open-ended plan.
const MEMBER_PRO_UNTIL_FIELDS = ['Pro until', 'Pro Until', 'Pro ends', 'Pro end date', 'Pro expiry'];
// ISO timestamp of the member's last request, written by the Worker. The console shows a green
// dot while it is recent and the time otherwise.
const LAST_ACTIVE_FIELD = 'Last active';
/** How often one member's cell may be rewritten by this isolate. */
const LAST_ACTIVE_WRITE_MS = 2 * 60 * 1000;

/** A Members row's own Pro end as epoch ms; 0 when the row leaves it empty or unreadable. */
function memberProUntilMs(fields = {}) {
  const ms = Date.parse(firstString(fields, MEMBER_PRO_UNTIL_FIELDS));
  return Number.isFinite(ms) ? ms : 0;
}
/** A member counts as active while their last request is this recent. */
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

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
    asks: sameDay ? usageNumber(fields, USAGE_FIELDS.asks) : 0,
  };
}

/** What a level may do today, with the used/remaining split the app displays. */
export function usageSummary(level, usage = {}) {
  const limits = LIMITS[normaliseLevel(level)];
  const viewsUsed = Math.max(0, Math.floor(Number(usage.views) || 0));
  const downloadsUsed = Math.max(0, Math.floor(Number(usage.downloads) || 0));
  const asksUsed = Math.max(0, Math.floor(Number(usage.asks) || 0));
  return {
    date: usage.date || null,
    viewsLimit: limits.views,
    viewsUsed,
    viewsRemaining: Math.max(0, limits.views - viewsUsed),
    downloadsLimit: limits.downloads,
    downloadsUsed,
    downloadsRemaining: Math.max(0, limits.downloads - downloadsUsed),
    asksLimit: limits.asks,
    asksUsed,
    asksRemaining: Math.max(0, limits.asks - asksUsed),
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
    'X-Quota-Asks-Limit': String(summary.asksLimit),
    'X-Quota-Asks-Used': String(summary.asksUsed),
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
  } else if (kind === 'ask') {
    message = `All ${summary.asksLimit} ${label} Ask AI questions for today are used. Pro allows ${LIMITS.pro.asks} a day and Max ${LIMITS.max.asks}; the count resets at 00:00 UTC.`;
  } else {
    message = `All ${summary.viewsLimit} ${label} PDF views for today are used. Pro allows ${LIMITS.pro.views} views a day and Max ${LIMITS.max.views}; the count resets at 00:00 UTC.`;
  }
  return new HttpError(429, 'quota_exceeded', message, {
    payload: { kind, level: normaliseLevel(level), usage: summary },
    headers: quotaHeaders(level, summary),
  });
}

/**
 * A sliding one-minute limiter shared by every member in this isolate. Gemini's free tier allows
 * only a handful of generateContent calls per minute; refusing at the door with a Retry-After is
 * cheaper than spending the day collecting 429s from upstream. Returns 0 when a slot is free,
 * otherwise the seconds to wait.
 */
export function createRateGate({
  limit = DEFAULT_GEMINI_RPM,
  windowMs = 60_000,
  now = Date.now,
} = {}) {
  const hits = [];
  return function take() {
    const current = now();
    while (hits.length && current - hits[0] >= windowMs) hits.shift();
    if (hits.length >= limit) {
      return Math.max(1, Math.ceil((windowMs - (current - hits[0])) / 1000));
    }
    hits.push(current);
    return 0;
  };
}

/** base64 for a byte array, in chunks so a multi-megabyte PDF cannot overflow the call stack. */
export function base64FromBytes(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
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
    geminiApiKey: String(env.GEMINI_API_KEY || '').trim(),
    geminiModel: String(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim(),
    geminiApiBase: String(env.GEMINI_API_BASE || DEFAULT_GEMINI_API_BASE).replace(/\/+$/, ''),
    geminiRpm: positiveInt(env.GEMINI_RPM, DEFAULT_GEMINI_RPM),
    appVersionCode: positiveInt(env.APP_VERSION_CODE, 2),
    appVersionName: String(env.APP_VERSION_NAME || '1.1').trim(),
    appMinSupported: positiveInt(env.APP_MIN_SUPPORTED, 1),
    appApkUrl: String(env.APP_APK_URL || '').trim(),
    appReleaseNotes: String(env.APP_RELEASE_NOTES || '').trim(),
    invitesKv: env.INVITES || null,
    inviteTrialDays: positiveInt(env.INVITE_TRIAL_DAYS, INVITE_TRIAL_DAYS),
    uploadsTable: String(env.AIRTABLE_UPLOADS_TABLE || 'Method uploads').trim(),
    uploadContentApi: String(env.AIRTABLE_CONTENT_API || 'https://content.airtable.com/v0')
      .replace(/\/+$/, ''),
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
          ? 'Airtable rejected the fields; check the table and its column names.'
          : response.status === 404
            ? 'Airtable table not found; check the table name and that it is in this base.'
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
  // Assistant brakes and caches, per isolate: the Gemini rate gate is shared by every member this
  // instance serves, so a burst from several phones still stays under the upstream RPM.
  const geminiGate = createRateGate({ limit: config.geminiRpm, now });
  const askingMembers = new Set();
  const pdfCache = new Map();

  /**
   * Records that the member just used the app, for the admin console's presence line. The stored
   * cell is the clock: a write is skipped while it already holds a time inside
   * LAST_ACTIVE_WRITE_MS, so the throttle holds for every isolate instead of one in-memory timer
   * per isolate. The write runs after the response has gone out (`ctx.waitUntil`) and a failure —
   * a read-only token, say — is logged, never returned to the member.
   */
  async function recordActivity(activity, ctx) {
    if (!activity?.recordId) return;
    const at = now();
    if (at - activity.lastActiveMs < LAST_ACTIVE_WRITE_MS) return;
    activity.lastActiveMs = at; // also holds off a second write while this one is in flight
    const write = airtableWrite({
      config,
      table: config.membersTable,
      recordId: activity.recordId,
      fields: { [LAST_ACTIVE_FIELD]: new Date(at).toISOString() },
      fetchImpl,
      throttle: createThrottle(),
    }).catch((error) => {
      // Keep the timestamp: a token without write access would otherwise retry, and log, on
      // every single request. The next attempt comes after the window.
      console.warn('[proxy] last active not recorded:', error?.message || error);
    });
    // Without an execution context (the self-test) waiting keeps behaviour observable.
    if (ctx?.waitUntil) ctx.waitUntil(write);
    else await write;
  }

  // ---------------------------------------------------------------------------
  // Invitation codes and their Pro trial  (app ↔ proxy ↔ KV)
  // ---------------------------------------------------------------------------

  const inviteKv = config.invitesKv;
  const inviteTrialMs = config.inviteTrialDays * 24 * 60 * 60 * 1000;

  /** The KV namespace, or a clear refusal when this deployment has none yet. */
  function inviteStore() {
    if (!inviteKv || typeof inviteKv.get !== 'function') {
      throw new HttpError(
        503,
        'invites_unavailable',
        'Invitation codes are not configured on this server yet.',
      );
    }
    return inviteKv;
  }

  async function readInviteJson(key) {
    const raw = await inviteStore().get(key);
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw === 'string' && raw) {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function writeInviteJson(key, value) {
    await inviteStore().put(key, JSON.stringify(value));
  }

  const inviteCodeKey = (code) => `code:${normaliseInviteCode(code)}`;
  const inviteMemberKey = (email) => `member:${String(email || '').trim().toLowerCase()}`;
  const isoOrNull = (ms) =>
    Number.isFinite(ms) && ms > now() ? new Date(ms).toISOString() : null;

  /**
   * A member's invitation state: their own code (created once, then stable), the number of members
   * who joined with it, and the end of an invite-earned Pro trial.
   */
  async function inviteFor(email) {
    const key = inviteMemberKey(email);
    let state = (await readInviteJson(key)) || {};
    if (!state.code) {
      for (let attempt = 0; attempt < 5 && !state.code; attempt += 1) {
        const code = randomInviteCode();
        if (await readInviteJson(inviteCodeKey(code))) continue; // taken by another member
        state = { ...state, code, createdAt: new Date(now()).toISOString() };
        await writeInviteJson(inviteCodeKey(code), { email: String(email).toLowerCase() });
        await writeInviteJson(key, state);
      }
      if (!state.code) {
        throw new HttpError(503, 'invite_code_failed', 'An invitation code could not be created. Try again.');
      }
    }
    return state;
  }

  /**
   * The end of this member's invite trial as epoch ms (0 when none). A KV outage must never stop
   * a member from reading the library, so a failure reads as "no trial".
   */
  async function proUntilFor(email) {
    if (!inviteKv || typeof inviteKv.get !== 'function') return 0;
    try {
      const state = await readInviteJson(inviteMemberKey(email));
      const until = Date.parse(String(state?.proUntil || ''));
      return Number.isFinite(until) ? until : 0;
    } catch {
      return 0;
    }
  }

  /** The Level column on a row, read without touching the membership cache. */
  async function storedLevelFor(email) {
    try {
      const records = await airtableList({
        config,
        table: config.membersTable,
        filterByFormula: `LOWER({Email})='${escapeFormulaValue(String(email).toLowerCase())}'`,
        maxRecords: 1,
        fetchImpl,
        throttle: createThrottle(),
      });
      return normaliseLevel(firstString(records[0]?.fields || {}, LEVEL_FIELDS));
    } catch {
      return 'basic';
    }
  }

  /** GET /api/invite — the signed-in member's own code and trial. */
  async function inviteStatus(request) {
    const { identity, membership } = await requireMember(request);
    const email = String(identity.email || '').trim().toLowerCase();
    const state = await inviteFor(email);
    const proUntilMs = Date.parse(String(state.proUntil || ''));
    const level = effectiveLevel(membership.level, proUntilMs, now());
    return jsonResponse(
      200,
      {
        code: formatInviteCode(state.code),
        proUntil: isoOrNull(proUntilMs),
        trialDays: config.inviteTrialDays,
        invites: Math.max(0, Number(state.invites) || 0),
        redeemed: Boolean(state.redeemedAt),
        level,
        levelLabel: levelLabel(level),
      },
      { Vary: 'Authorization' },
    );
  }

  /**
   * POST /api/invite/redeem — a member joins with someone else's code. Both sides get the trial,
   * each member may redeem one code in their lifetime, and redeeming your own code is refused.
   */
  async function redeemInvite(request) {
    const { identity, membership } = await requireMember(request);
    const email = String(identity.email || '').trim().toLowerCase();
    const payload = await jsonBody(request);
    const code = normaliseInviteCode(payload?.code);
    if (code.length !== INVITE_CODE_LENGTH) {
      throw new HttpError(400, 'invalid_invite_code', 'Enter the 8-character invitation code.');
    }

    const invite = await readInviteJson(inviteCodeKey(code));
    const inviterEmail = String(invite?.email || '').trim().toLowerCase();
    if (!inviterEmail) {
      throw new HttpError(
        404,
        'unknown_invite_code',
        'That invitation code was not found. Check it with the member who sent it.',
      );
    }
    if (inviterEmail === email) {
      throw new HttpError(400, 'own_invite_code', 'That is your own code — share it with a colleague instead.');
    }

    const own = (await readInviteJson(inviteMemberKey(email))) || {};
    if (own.redeemedAt) {
      throw new HttpError(409, 'invite_already_used', 'You have already used an invitation code.');
    }

    const at = now();
    const ownUntil = at + inviteTrialMs;
    const inviterState = (await readInviteJson(inviteMemberKey(inviterEmail))) || {};
    // Extending from the later of now and the inviter's running trial, so credits add up.
    const inviterUntil = Math.max(Date.parse(String(inviterState.proUntil || '')) || 0, at) + inviteTrialMs;

    await writeInviteJson(inviteMemberKey(inviterEmail), {
      ...inviterState,
      code: inviterState.code || code,
      invites: Math.max(0, Number(inviterState.invites) || 0) + 1,
      proUntil: new Date(inviterUntil).toISOString(),
      lastInvitedAt: new Date(at).toISOString(),
    });
    await writeInviteJson(inviteMemberKey(email), {
      ...own,
      redeemedAt: new Date(at).toISOString(),
      invitedBy: inviterEmail,
      proUntil: new Date(ownUntil).toISOString(),
    });

    // Both rows must be read again on the next request, not served from the cached Basic level.
    membershipCache.delete(email);
    membershipCache.delete(inviterEmail);

    const level = effectiveLevel(membership.level, ownUntil, at);
    const inviterLevel = effectiveLevel(await storedLevelFor(inviterEmail), inviterUntil, at);
    return jsonResponse(
      200,
      {
        ok: true,
        code: formatInviteCode(code),
        level,
        levelLabel: levelLabel(level),
        proUntil: new Date(ownUntil).toISOString(),
        trialDays: config.inviteTrialDays,
        inviter: {
          email: inviterEmail,
          level: inviterLevel,
          levelLabel: levelLabel(inviterLevel),
          proUntil: new Date(inviterUntil).toISOString(),
        },
      },
      { Vary: 'Authorization' },
    );
  }

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
    // A Google account with no Members row at all is joining now: the app offers it the referral
    // prompt once, and never to a member who was already in the table (even a pending row).
    const justJoined = !active && records.length === 0;
    let value =
      active
        ? membershipValue(active, identity)
        : records.length > 0
          ? { member: false, level: null, levelLabel: null, name: null, role: 'Member', reason: 'inactive' }
          : membershipValue(await joinAsBasic({ config, identity, fetchImpl }), identity);

    // An invite-earned or upload-earned Pro trial is layered over the stored level, never written
    // to the row. Approved uploads are turned into days first, so they count from this response.
    if (value.member) {
      await grantUploadRewards(email);
      // Whichever runs longer: the earned trial in KV or the end date an admin typed on the row.
      const proUntilMs = Math.max(await proUntilFor(email), memberProUntilMs(active?.fields));
      const level = effectiveLevel(value.level, proUntilMs, now());
      value = { ...value, level, levelLabel: levelLabel(level), proUntil: isoOrNull(proUntilMs) };
    }

    // The row's own "Last active" value, so recordActivity can leave a cell that already says
    // "just now" alone. A member who just joined has none yet, hence 0.
    const storedLastActive = active
      ? Date.parse(firstString(active.fields, [LAST_ACTIVE_FIELD]))
      : NaN;
    const entry = {
      expiresAt: now() + config.membershipTtlMs,
      value,
      recordId,
      lastActiveMs: Number.isFinite(storedLastActive) ? storedLastActive : 0,
      // Read (and cleared) by /api/me, so a brand-new account is announced exactly once.
      justJoined: justJoined && value.member === true,
    };
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
  async function adminMemberRow(record) {
    const fields = record?.fields || {};
    const email = firstString(fields, MEMBER_EMAIL_FIELDS);
    if (!email) return null;
    const proUntilMs = Math.max(await proUntilFor(email), memberProUntilMs(fields));
    const level = effectiveLevel(firstString(fields, LEVEL_FIELDS), proUntilMs, now());
    const lastActiveRaw = firstString(fields, [LAST_ACTIVE_FIELD]);
    const lastActiveMs = Date.parse(lastActiveRaw);
    const lastActiveAt = Number.isFinite(lastActiveMs) ? new Date(lastActiveMs).toISOString() : null;
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
      lastActiveAt,
      online: lastActiveAt ? now() - lastActiveMs <= ACTIVE_WINDOW_MS : false,
      proUntil: isoOrNull(proUntilMs),
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
      const row = await adminMemberRow(record);
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

    const row = await adminMemberRow({ id: recordId, fields: { ...current, ...fields } });
    return jsonResponse(200, { ok: true, member: row });
  }

  /**
   * One upload row as the admin console sees it. The file itself is never streamed through this
   * endpoint: the console lists what was submitted and the AI review, and reviews the file in
   * Airtable when a human wants to read the whole document.
   */
  function adminUploadRow(record) {
    const fields = record?.fields || {};
    const attachment = findAttachments(fields)[0] || null;
    const numeric = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    return {
      id: String(record?.id || ''),
      title: firstString(fields, [UPLOAD_FIELDS.title]),
      email: firstString(fields, [UPLOAD_FIELDS.email]).toLowerCase(),
      name: firstString(fields, [UPLOAD_FIELDS.name]),
      status: firstString(fields, [UPLOAD_FIELDS.status]) || UPLOAD_NEW_STATUS,
      submittedAt:
        firstString(fields, [UPLOAD_FIELDS.submittedAt]) || String(record?.createdTime || ''),
      days: numeric(firstString(fields, [UPLOAD_FIELDS.days])),
      proUntil: firstString(fields, [UPLOAD_FIELDS.proUntil]),
      reviewNote: firstString(fields, [UPLOAD_FIELDS.reviewNote]),
      fileName:
        firstString(fields, [UPLOAD_FIELDS.fileName]) || String(attachment?.filename || ''),
      contentType:
        firstString(fields, [UPLOAD_FIELDS.contentType]) || String(attachment?.type || ''),
      size: numeric(firstString(fields, [UPLOAD_FIELDS.size])) || numeric(attachment?.size),
      methodName: firstString(fields, [UPLOAD_FIELDS.methodName]),
      scope: firstString(fields, [UPLOAD_FIELDS.scope]),
      standard: firstString(fields, [UPLOAD_FIELDS.standard]),
      publishedIn: firstString(fields, [UPLOAD_FIELDS.publishedIn]),
    };
  }

  /**
   * GET /api/admin/uploads lists the member submissions, newest first, so an administrator can
   * review them from inside the app instead of opening Airtable.
   */
  async function adminUploads(request) {
    await requireAdmin(request);
    const records = await airtableList({
      config,
      table: config.uploadsTable,
      filterByFormula: '',
      maxRecords: 200,
      fetchImpl,
      throttle: createThrottle(),
    });
    const uploads = records
      .map(adminUploadRow)
      .filter((row) => row.id && (row.title || row.fileName))
      .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    return jsonResponse(200, {
      uploads,
      total: uploads.length,
      assistant: Boolean(config.geminiApiKey),
      tables: config.methodsTables,
      note: 'One row per submitted method. Approving adds Days of Pro and can publish the method into the library.',
    });
  }

  /**
   * POST /api/admin/uploads/:recordId/analyse reads the uploaded file with Gemini and writes back
   * the method's name, scope and standard so the reviewer starts from a filled-in row.
   *
   * The model gets the file inline when it is a PDF or an image (the two formats Gemini reads),
   * and otherwise works from the title and filename only, saying so in `groundedIn`. The result is
   * stored on the uploads row, so the same values are visible in Airtable.
   */
  async function analyseUpload(request, recordId) {
    await requireAdmin(request);
    if (!/^rec[A-Za-z0-9]{14}$/.test(String(recordId || ''))) {
      throw new HttpError(400, 'bad_request', 'A valid upload record id is required.');
    }
    if (!config.geminiApiKey) {
      throw new HttpError(
        503,
        'gemini_not_configured',
        'AI review is not configured: set the Worker secret GEMINI_API_KEY to a Google AI Studio key.',
      );
    }

    const record = await airtableRecord({
      config,
      table: config.uploadsTable,
      recordId,
      fetchImpl,
      throttle: createThrottle(),
    });
    const fields = record?.fields || {};
    const title = firstString(fields, [UPLOAD_FIELDS.title]);
    const attachment = findAttachments(fields)[0] || null;

    const waitSeconds = geminiGate();
    if (waitSeconds > 0) {
      throw new HttpError(
        429,
        'assistant_busy',
        `The assistant is busy right now. Try again in ${waitSeconds} seconds.`,
        { headers: { 'Retry-After': String(waitSeconds) } },
      );
    }

    const contentType = String(
      firstString(fields, [UPLOAD_FIELDS.contentType]) || attachment?.type || '',
    ).toLowerCase();
    const parts = [];
    let groundedIn = 'title';
    if (attachment && (contentType === 'application/pdf' || contentType.startsWith('image/'))) {
      const upstream = await fetchImpl(attachment.url);
      if (!upstream.ok) {
        throw new HttpError(
          502,
          'attachment_error',
          `The uploaded file could not be read (HTTP ${upstream.status}).`,
        );
      }
      const bytes = new Uint8Array(await upstream.arrayBuffer());
      if (bytes.length > 0) {
        parts.push({ inline_data: { mime_type: contentType, data: base64FromBytes(bytes) } });
        groundedIn = 'file';
      }
    } else if (attachment && contentType === 'text/plain') {
      const upstream = await fetchImpl(attachment.url);
      if (upstream.ok) {
        const text = (await upstream.text()).slice(0, 20000);
        if (text.trim()) {
          parts.push({ text: `Document text:\n${text}` });
          groundedIn = 'text';
        }
      }
    }

    const system =
      'You review a textile testing laboratory method document submitted to a method library. ' +
      'Read it and reply with JSON only, shaped exactly like ' +
      '{"methodName": "...", "scope": "...", "standard": "..."}. ' +
      'methodName is the method designation as printed in the document (for example ' +
      '"ISO 105-C06" or "AATCC TM61"); if the document has no designation, use a short descriptive ' +
      'name. scope is one to three sentences describing what the method covers and which ' +
      'materials or properties it applies to, taken from the document\'s scope section. standard is ' +
      '"ISO", "AATCC" or "" when the document does not make it clear. Never invent a designation, ' +
      'a clause number, a limit or a scope detail that the document does not contain; use an empty ' +
      'string instead.';
    const requestText =
      `Submitted title: ${title || '(none)'}\n` +
      `File name: ${firstString(fields, [UPLOAD_FIELDS.fileName]) || attachment?.filename || '(none)'}\n` +
      `Content type: ${contentType || '(unknown)'}` +
      (groundedIn === 'title'
        ? '\nThe file itself could not be read, so work from the title and file name only and keep scope short.'
        : '');
    parts.push({ text: requestText });

    const response = await fetchImpl(
      `${config.geminiApiBase}/models/${encodeURIComponent(config.geminiModel)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.geminiApiKey,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 900,
            responseMimeType: 'application/json',
          },
        }),
      },
    );
    const raw = await response.text();
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      body = {};
    }
    if (response.status === 429) {
      throw new HttpError(429, 'assistant_busy', 'The AI service is busy right now. Try again in a minute.', {
        headers: { 'Retry-After': '60' },
      });
    }
    if (!response.ok) {
      const detail = String(body?.error?.message || '').slice(0, 300);
      throw new HttpError(
        502,
        'gemini_error',
        detail ? `The file could not be analysed: ${detail}` : `The file could not be analysed (HTTP ${response.status}).`,
      );
    }

    const answer = (body?.candidates?.[0]?.content?.parts || [])
      .filter((part) => part && typeof part.text === 'string' && !part.thought)
      .map((part) => part.text)
      .join('')
      .trim();
    const analysis = parseUploadAnalysis(answer);
    if (!analysis.methodName && !analysis.scope) {
      throw new HttpError(502, 'gemini_empty', 'The AI review returned nothing usable. Try again.');
    }

    await airtableWrite({
      config,
      table: config.uploadsTable,
      recordId,
      fields: {
        [UPLOAD_FIELDS.methodName]: analysis.methodName,
        [UPLOAD_FIELDS.scope]: analysis.scope,
        [UPLOAD_FIELDS.standard]: analysis.standard,
      },
      fetchImpl,
      throttle: createThrottle(),
    });

    return jsonResponse(200, {
      ok: true,
      ...analysis,
      model: config.geminiModel,
      groundedIn,
    });
  }

  /**
   * POST /api/admin/uploads/:recordId/review approves or rejects one upload.
   *
   * Approving writes `Status` = Approved and `Days` (1–30) to the row, which is exactly what
   * grantUploadRewards turns into a Pro trial on the member's next request, and optionally copies
   * the file into the chosen library table (`ISO` or `AATCC`) with the AI's method name and scope.
   * Rejecting stores the reason in `Review note`. A row already marked `Rewarded` is never paid
   * twice.
   */
  async function reviewUpload(request, recordId) {
    await requireAdmin(request);
    if (!/^rec[A-Za-z0-9]{14}$/.test(String(recordId || ''))) {
      throw new HttpError(400, 'bad_request', 'A valid upload record id is required.');
    }

    const payload = await jsonBody(request);
    const decision = String(payload?.decision || '').trim().toLowerCase();
    if (decision !== 'approve' && decision !== 'reject') {
      throw new HttpError(400, 'invalid_decision', 'Send decision "approve" or "reject".');
    }

    const record = await airtableRecord({
      config,
      table: config.uploadsTable,
      recordId,
      fetchImpl,
      throttle: createThrottle(),
    });
    const fields = record?.fields || {};
    const currentStatus = firstString(fields, [UPLOAD_FIELDS.status]);

    const methodName = String(
      payload?.methodName ?? firstString(fields, [UPLOAD_FIELDS.methodName]),
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150);
    const scope = String(payload?.scope ?? firstString(fields, [UPLOAD_FIELDS.scope]))
      .trim()
      .slice(0, 2000);
    const standard = String(payload?.standard ?? firstString(fields, [UPLOAD_FIELDS.standard]))
      .trim()
      .slice(0, 40);
    const note = String(payload?.note || '').trim().slice(0, 1000);

    if (decision === 'reject') {
      await airtableWrite({
        config,
        table: config.uploadsTable,
        recordId,
        fields: {
          [UPLOAD_FIELDS.status]: 'Rejected',
          [UPLOAD_FIELDS.reviewNote]: note || 'Rejected by an administrator.',
          [UPLOAD_FIELDS.methodName]: methodName,
          [UPLOAD_FIELDS.scope]: scope,
          [UPLOAD_FIELDS.standard]: standard,
        },
        fetchImpl,
        throttle: createThrottle(),
      });
      return jsonResponse(200, { ok: true, status: 'Rejected', days: 0, publishedIn: '' });
    }

    const days = Math.floor(Number(payload?.days));
    if (!Number.isFinite(days) || days < UPLOAD_TRIAL_MIN_DAYS || days > UPLOAD_TRIAL_MAX_DAYS) {
      throw new HttpError(
        400,
        'invalid_days',
        `Days must be a whole number between ${UPLOAD_TRIAL_MIN_DAYS} and ${UPLOAD_TRIAL_MAX_DAYS}.`,
      );
    }
    if (currentStatus === 'Rewarded') {
      throw new HttpError(
        409,
        'already_rewarded',
        'This upload has already added its Pro days. Nothing was changed.',
      );
    }

    const publish = payload?.publish !== false;
    const table = String(payload?.table || '').trim();
    if (publish && !config.methodsTables.includes(table)) {
      throw new HttpError(
        400,
        'invalid_table',
        `Choose one of the library tables: ${config.methodsTables.join(', ')}.`,
      );
    }
    if (publish && !methodName) {
      throw new HttpError(
        400,
        'missing_method_name',
        'Analyse the file or type the method name before adding it to the library.',
      );
    }

    // Copy the submitted file and details into the library before the row is marked approved, so
    // an approval never leaves a method row without its document.
    // If the same upload is approved twice we reuse the existing library row instead of creating
    // a duplicate, making publishing safe to retry.
    let publishedIn = '';
    if (publish) {
      const title = firstString(fields, [UPLOAD_FIELDS.title]);
      // Look for an existing library row with the same method name and submitted title.
      const existing = await airtableList({
        config,
        table,
        filterByFormula: `AND({Method}=${JSON.stringify(methodName)}, '{Method Name}'=${JSON.stringify(title)})`,
        maxRecords: 1,
        fetchImpl,
        throttle: createThrottle(),
      });
      if (existing && existing.length > 0) {
        // Reuse the existing row – it already has its file attached.
        const existingRecord = existing[0];
        publishedIn = `${table}/${existingRecord.id}`;
      } else {
        const created = await airtableWrite({
          config,
          table,
          fields: {
            Method: methodName,
            'Method Name': title || methodName,
            Scope: scope,
          },
          fetchImpl,
          throttle: createThrottle(),
        });
        const methodRecordId = String(created?.id || '');
        if (!methodRecordId) {
          throw new HttpError(502, 'publish_failed', 'The method row was not created. Try again.');
        }
        if (attachment) {
          const upstream = await fetchImpl(attachment.url);
          if (!upstream.ok) {
            throw new HttpError(
              502,
              'publish_failed',
              `The method row ${methodRecordId} was created but its file could not be read (HTTP ${upstream.status}). Attach the file in Airtable.`,
            );
          }
          const bytes = new Uint8Array(await upstream.arrayBuffer());
          const uploaded = await fetchImpl(
            `${config.uploadContentApi}/${config.baseId}/${methodRecordId}/` +
              `${encodeURIComponent('File')}/uploadAttachment`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${config.airtableToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                contentType: attachment.type || 'application/pdf',
                file: base64FromBytes(bytes),
                filename: attachment.filename || 'method.pdf',
              }),
            },
          );
          if (!uploaded.ok) {
            throw new HttpError(
              502,
              'publish_failed',
              `The method row ${methodRecordId} was created but its file was not attached (HTTP ${uploaded.status}). Attach it in Airtable.`,
            );
          }
        }
        publishedIn = `${table}/${methodRecordId}`;
      }
    }

    const approvalFields = {
      [UPLOAD_FIELDS.status]: 'Approved',
      [UPLOAD_FIELDS.days]: days,
      [UPLOAD_FIELDS.methodName]: methodName,
      [UPLOAD_FIELDS.scope]: scope,
      [UPLOAD_FIELDS.standard]: standard,
      [UPLOAD_FIELDS.publishedIn]: publishedIn,
    };
    // A note typed in the console is kept; an empty one never clears what Airtable already says.
    if (note) approvalFields[UPLOAD_FIELDS.reviewNote] = note;

    await airtableWrite({
      config,
      table: config.uploadsTable,
      recordId,
      fields: approvalFields,
      fetchImpl,
      throttle: createThrottle(),
    });

    // Turn the approval into the Pro days right away; grantUploadRewards is idempotent, so the
    // member's next request can never pay the same row twice.
    try {
      await grantUploadRewards(firstString(fields, [UPLOAD_FIELDS.email]));
    } catch {
      // The row is Approved and Days is set, so the next member request still pays it out.
    }

    return jsonResponse(200, {
      ok: true,
      status: 'Approved',
      days,
      publishedIn,
      table: publishedIn ? table : '',
    });
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

  // ---------------------------------------------------------------------------
  // Method uploads  (app ↔ proxy ↔ Airtable uploads table + an approved Pro trial)
  // ---------------------------------------------------------------------------

  /**
   * POST /api/method-uploads stores a title and one file in the uploads table.
   *
   * The author is the verified account on the ID token, never anything in the body. The file goes
   * into an Airtable attachment field through Airtable's content API, so the row itself is all an
   * administrator needs to review it.
   */
  async function submitMethodUpload(request) {
    const { identity, membership } = await requireMember(request);
    if (!config.airtableToken) {
      throw new HttpError(503, 'uploads_unavailable', 'Uploads are not configured on this server yet.');
    }
    const payload = await jsonBody(request);
    const title = String(payload?.title || '').trim().replace(/\s+/g, ' ').slice(0, 150);
    if (title.length < 3) {
      throw new HttpError(400, 'invalid_title', 'Give the method or document a title.');
    }
    const contentType = String(payload?.contentType || '').trim().toLowerCase() || 'application/pdf';
    if (!UPLOAD_CONTENT_TYPES.has(contentType)) {
      throw new HttpError(
        400,
        'invalid_file_type',
        'Upload a PDF, Word document, text file or an image.',
      );
    }
    const file = String(payload?.file || '').replace(/\s+/g, '');
    if (!file || !/^[A-Za-z0-9+/]+={0,2}$/.test(file)) {
      throw new HttpError(400, 'invalid_file', 'Choose the method file to upload.');
    }
    const padding = file.endsWith('==') ? 2 : file.endsWith('=') ? 1 : 0;
    const size = Math.floor((file.length * 3) / 4) - padding;
    if (size > UPLOAD_MAX_BYTES) {
      throw new HttpError(
        413,
        'file_too_large',
        `Keep the file under ${Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`,
      );
    }
    const filename = (String(payload?.filename || '').trim().slice(0, 150) || 'method.pdf')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_');

    const fields = {
      [UPLOAD_FIELDS.title]: title,
      [UPLOAD_FIELDS.email]: identity.email.toLowerCase(),
      [UPLOAD_FIELDS.name]: String(membership?.name || identity.name || identity.email).trim(),
      [UPLOAD_FIELDS.fileName]: filename,
      [UPLOAD_FIELDS.contentType]: contentType,
      [UPLOAD_FIELDS.size]: size,
      [UPLOAD_FIELDS.status]: UPLOAD_NEW_STATUS,
      [UPLOAD_FIELDS.submittedAt]: new Date(now()).toISOString(),
    };
    const created = await airtableWrite({
      config,
      table: config.uploadsTable,
      fields,
      fetchImpl,
      throttle: createThrottle(),
    });
    const recordId = String(created?.id || '');
    if (!recordId) {
      throw new HttpError(502, 'upload_failed', 'The upload was not stored. Try again.');
    }

    const response = await fetchImpl(
      `${config.uploadContentApi}/${config.baseId}/${recordId}/` +
        `${encodeURIComponent(UPLOAD_FIELDS.file)}/uploadAttachment`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.airtableToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ contentType, file, filename }),
      },
    );
    if (!response.ok) {
      // Leave the row with a status an administrator can act on instead of a half-finished upload.
      try {
        await airtableWrite({
          config,
          table: config.uploadsTable,
          recordId,
          fields: { [UPLOAD_FIELDS.status]: 'Upload failed' },
          fetchImpl,
          throttle: createThrottle(),
        });
      } catch {
        // Nothing else to do: the clear error below still reaches the member.
      }
      throw new HttpError(
        502,
        'upload_failed',
        response.status === 401 || response.status === 403
          ? 'The method store rejected the upload. Check the Airtable token and the uploads table.'
          : `The method store could not take that file (HTTP ${response.status}).`,
      );
    }

    return jsonResponse(200, {
      ok: true,
      id: recordId,
      status: UPLOAD_NEW_STATUS,
      note:
        'Thanks — an administrator reviews each upload and adds 1 to 30 days of Pro to your plan.',
    });
  }

  /**
   * Turns approved uploads into Pro days.
   *
   * An administrator reviews the row in Airtable and sets `Status` to `Approved` plus `Days`
   * (1–30). The next request from that member adds those days to the running trial and marks the
   * row `Rewarded`, so a row is never paid out twice. Checked at most once every five minutes per
   * member through KV, and any failure is swallowed: reviewing uploads can never block the library.
   */
  async function grantUploadRewards(email) {
    if (!inviteKv || typeof inviteKv.get !== 'function') return;
    const checkedKey = `uploads:checked:${String(email).toLowerCase()}`;
    try {
      if (await inviteKv.get(checkedKey)) return;
      await inviteKv.put(checkedKey, '1', { expirationTtl: 300 });
    } catch {
      return;
    }

    let records;
    try {
      records = await airtableList({
        config,
        table: config.uploadsTable,
        filterByFormula: `AND(LOWER({${UPLOAD_FIELDS.email}})='${escapeFormulaValue(
          String(email).toLowerCase(),
        )}',{${UPLOAD_FIELDS.status}}='Approved')`,
        maxRecords: 50,
        fetchImpl,
        throttle: createThrottle(),
      });
    } catch {
      return;
    }
    if (!records.length) return;

    const rewardsKey = `uploads:${String(email).toLowerCase()}`;
    const state = (await readInviteJson(rewardsKey)) || {};
    const applied = new Set(Array.isArray(state.applied) ? state.applied : []);
    let until = Date.parse(String(state.proUntil || '')) || 0;
    const awarded = [];

    for (const record of records) {
      const recordId = String(record?.id || '');
      if (!recordId || applied.has(recordId)) continue;
      const requested = Math.floor(Number(record?.fields?.[UPLOAD_FIELDS.days]));
      if (!Number.isFinite(requested) || requested < UPLOAD_TRIAL_MIN_DAYS) continue;
      const days = Math.min(UPLOAD_TRIAL_MAX_DAYS, requested);
      until = Math.max(until, now()) + days * 24 * 60 * 60 * 1000;
      applied.add(recordId);
      awarded.push({ recordId, days, until });
    }
    if (!awarded.length) return;

    await writeInviteJson(rewardsKey, {
      applied: [...applied],
      proUntil: new Date(until).toISOString(),
    });
    for (const reward of awarded) {
      try {
        await airtableWrite({
          config,
          table: config.uploadsTable,
          recordId: reward.recordId,
          fields: {
            [UPLOAD_FIELDS.status]: 'Rewarded',
            [UPLOAD_FIELDS.proUntil]: new Date(reward.until).toISOString(),
          },
          fetchImpl,
          throttle: createThrottle(),
        });
      } catch {
        // The applied id is already stored, so a failed status write cannot pay twice.
      }
    }

    // The trial is layered over the stored level through the member's KV record, so it shows in
    // the invite screen and in effectiveLevel exactly like an invite-earned trial.
    const member = (await readInviteJson(inviteMemberKey(email))) || {};
    const memberUntil = Math.max(Date.parse(String(member.proUntil || '')) || 0, until);
    await writeInviteJson(inviteMemberKey(email), {
      ...member,
      proUntil: new Date(memberUntil).toISOString(),
    });
    membershipCache.delete(email);
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

  /** The method row with [recordId], searched across the configured method tables. */
  async function methodRecord(recordId) {
    for (const table of config.methodsTables) {
      try {
        const record = await airtableRecord({
          config,
          table,
          recordId,
          fetchImpl,
          throttle: createThrottle(),
        });
        if (record?.id) return record;
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
    return null;
  }

  /**
   * The method the lab recorded as this one's counterpart in the other standard family, if any.
   * The link is an Airtable record id, so the row is read back with the same helper that serves a
   * normal method page; a dead link reads as "no counterpart" instead of failing the question.
   */
  async function counterpartRecord(record) {
    for (const id of counterpartIds(record?.fields || {})) {
      if (id === String(record?.id || '')) continue;
      try {
        const found = await methodRecord(id);
        if (found?.id) return found;
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
    return null;
  }

  /** The first PDF attached to a method row, base64 for Gemini's inline_data part. */
  async function documentPdf(record) {
    const attachment = findAttachments(record?.fields || {})[0];
    if (!attachment?.url) return null;
    const cacheKey = String(attachment.id || attachment.url);
    const cached = pdfCache.get(cacheKey);
    if (cached && now() - cached.at < DOCUMENT_PDF_CACHE_SECONDS * 1000) return cached;
    const declared = Number(attachment.size);
    if (Number.isFinite(declared) && declared > DOCUMENT_PDF_MAX_BYTES) return null;
    try {
      const response = await fetchImpl(attachment.url);
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length < 5 || bytes.length > DOCUMENT_PDF_MAX_BYTES) return null;
      // Only a real PDF is forwarded; a broken or replaced attachment falls back to the row text.
      if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') return null;
      const entry = { at: now(), data: base64FromBytes(bytes) };
      pdfCache.set(cacheKey, entry);
      while (pdfCache.size > DOCUMENT_PDF_CACHE_ENTRIES) {
        pdfCache.delete(pdfCache.keys().next().value);
      }
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * POST /api/documents/ask answers a member's question about one method.
   *
   * The method's own PDF is the source of truth: the Worker fetches the attached file and sends it
   * to Gemini as an inline PDF part, with the row's text fields as extra context. The file is kept
   * in this isolate for a few minutes, so the follow-up questions of one conversation do not
   * re-download it.
   *
   * Three brakes keep the lab's Gemini key from being spammed or from tripping the upstream rate
   * limit: the member's daily Ask AI allowance is reserved before the call and refunded on failure,
   * a sliding-minute gate (GEMINI_RPM) turns bursts away with Retry-After, and a member can only
   * have one question in flight at a time.
   */
  async function askDocument(request) {
    const { membership, recordId: memberRecordId } = await requireMember(request);
    if (!config.geminiApiKey) {
      throw new HttpError(
        500,
        'gemini_not_configured',
        'The document assistant is not configured: set the Worker secret GEMINI_API_KEY to a Google AI Studio key.',
      );
    }

    const payload = await jsonBody(request);
    const recordId = String(payload?.methodId || '').trim();
    if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
      throw new HttpError(400, 'bad_request', 'A valid method id is required.');
    }
    const question = String(payload?.question || '').trim();
    if (question.length < 2) {
      throw new HttpError(400, 'invalid_question', 'Type a question about this document first.');
    }
    if (question.length > DOCUMENT_QUESTION_LIMIT) {
      throw new HttpError(
        400,
        'invalid_question',
        `Keep the question under ${DOCUMENT_QUESTION_LIMIT} characters.`,
      );
    }

    const record = await methodRecord(recordId);
    if (!record) throw new HttpError(404, 'not_found', 'That method is no longer in the library.');

    if (memberRecordId && askingMembers.has(memberRecordId)) {
      throw new HttpError(
        429,
        'assistant_busy',
        'Wait for the current answer before asking another question.',
        { headers: { 'Retry-After': '5' } },
      );
    }
    const waitSeconds = geminiGate();
    if (waitSeconds > 0) {
      throw new HttpError(
        429,
        'assistant_busy',
        `The assistant is answering other questions right now. Try again in ${waitSeconds} seconds.`,
        { headers: { 'Retry-After': String(waitSeconds) } },
      );
    }

    // Reserve one of today's questions before spending the lab's key; refundAskQuota() gives it
    // back if the call fails.
    const quota = await consumeQuota({
      recordId: memberRecordId,
      level: membership.level,
      kind: 'ask',
    });

    const method = mapMethod(record, '');
    const context = documentContext(record.fields || {});
    const pdf = await documentPdf(record);
    // The lab pairs an ISO method with its AATCC counterpart through a link column. When a pair is
    // recorded, the counterpart's PDF travels with the question so the answer can compare them; an
    // unpaired row simply answers from its own document, as before.
    const counterpart = await counterpartRecord(record);
    const counterpartMethod = counterpart ? mapMethod(counterpart, '') : null;
    const counterpartContext = counterpart ? documentContext(counterpart.fields || {}) : '';
    let counterpartPdf = counterpart ? await documentPdf(counterpart) : null;
    if (
      pdf &&
      counterpartPdf &&
      pdf.data.length + counterpartPdf.data.length > DOCUMENT_PAIR_MAX_BASE64
    ) {
      // Both files would not fit one inline request: keep the one being read and compare against
      // the counterpart's recorded details instead of its PDF.
      counterpartPdf = null;
    }
    const instruction = pdf
      ? "The method's full PDF is attached to the final question. Treat its text as the source " +
        'of truth: quote clause numbers, limits and tolerances only as they appear in that PDF, ' +
        'and say plainly when a question is outside what the document covers.'
      : "The method's PDF could not be read for this request, so only the recorded details below " +
        'are available. Say plainly when a question needs the full document, and never invent ' +
        'clause numbers, limits or tolerances.';
    const comparison = counterpart
      ? ` The library pairs this method with a counterpart in the other standard: ${counterpartMethod.title}` +
        (counterpartPdf ? ' (its PDF is attached as well)' : ' (only its recorded details are available)') +
        '. When the member asks to compare them, or when the counterpart makes the answer clearer,' +
        ' compare the two on scope, specimen, procedure, limits/tolerances and reporting, and name' +
        ' the method each value comes from. Never call the two equivalent unless the documents say' +
        ' so; the pair is a library link, not proof of equivalence.'
      : '';
    const system =
      'You answer questions about one textile test method for a member of the TexLab app. ' +
      instruction +
      comparison +
      ' Be concise and practical, and answer in the language of the question.\n\n' +
      `Document: ${method.title}` +
      (method.name && method.name !== method.title ? ` — ${method.name}` : '') +
      '\n' +
      (context || 'No further details were recorded for this method.') +
      (counterpart
        ? `\n\nCounterpart in the library: ${counterpartMethod.title}` +
          (counterpartMethod.name && counterpartMethod.name !== counterpartMethod.title
            ? ` — ${counterpartMethod.name}`
            : '') +
          '\n' +
          (counterpartContext || 'No further details were recorded for this counterpart.')
        : '');

    const questionParts = [];
    if (pdf) {
      questionParts.push({ inline_data: { mime_type: 'application/pdf', data: pdf.data } });
    }
    if (counterpartPdf) {
      questionParts.push({ text: `Counterpart method document: ${counterpartMethod.title}` });
      questionParts.push({
        inline_data: { mime_type: 'application/pdf', data: counterpartPdf.data },
      });
    }
    questionParts.push({ text: question });
    const contents = [
      ...sanitiseChatHistory(payload?.history).map((turn) => ({
        role: turn.role,
        parts: [{ text: turn.text }],
      })),
      { role: 'user', parts: questionParts },
    ];

    if (memberRecordId) askingMembers.add(memberRecordId);
    try {
      const response = await fetchImpl(
        `${config.geminiApiBase}/models/${encodeURIComponent(config.geminiModel)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': config.geminiApiKey,
          },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system.slice(0, 20000) }] },
            contents,
            generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
          }),
        },
      );
      const text = await response.text();
      let body = {};
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
      // A 429 from Google is not retried here: retrying is exactly what trips the limit. The
      // member gets a short Retry-After and their reserved question back.
      if (response.status === 429) {
        throw new HttpError(
          429,
          'assistant_busy',
          'The AI service is busy right now. Try again in a minute.',
          { payload: { retryAfter: 60 }, headers: { 'Retry-After': '60' } },
        );
      }
      if (!response.ok) {
        const detail = String(body?.error?.message || '').slice(0, 300);
        throw new HttpError(
          502,
          'gemini_error',
          detail
            ? `The assistant could not answer: ${detail}`
            : `The assistant could not answer (HTTP ${response.status}).`,
          { payload: { status: response.status } },
        );
      }

      const answer = (body?.candidates?.[0]?.content?.parts || [])
        .filter((part) => part && typeof part.text === 'string' && !part.thought)
        .map((part) => part.text)
        .join('')
        .trim();
      if (!answer) {
        throw new HttpError(502, 'gemini_empty', 'The assistant returned an empty answer. Try again.');
      }
      return jsonResponse(
        200,
        {
          answer,
          model: config.geminiModel,
          methodId: recordId,
          groundedIn: pdf ? 'pdf' : 'metadata',
          comparison: counterpart
            ? {
                methodId: String(counterpart.id || ''),
                title: counterpartMethod.title,
                name: counterpartMethod.name || null,
                groundedIn: counterpartPdf ? 'pdf' : 'metadata',
              }
            : null,
          usage: quota.summary,
        },
        quotaHeaders(membership.level, quota.summary),
      );
    } catch (error) {
      await refundAskQuota(memberRecordId, quota.usage);
      throw error;
    } finally {
      if (memberRecordId) askingMembers.delete(memberRecordId);
    }
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
    if (!recordId) {
      return usageSummary(level, { date: todayKey(now), views: 0, downloads: 0, asks: 0 });
    }
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
      const levelNorm = normaliseLevel(level);
      const limits = LIMITS[levelNorm];
      if (kind === 'download' && limits.downloads === 0) {
        throw new HttpError(429, 'quota_exceeded', `Downloads are not included in the ${levelNorm.charAt(0).toUpperCase() + levelNorm.slice(1)} plan.`);
      }
      // Allow view/download/ask without updating counters (no row to update)
      return {
        level: levelNorm,
        usage: { date: today, views: 0, downloads: 0, asks: 0 },
        summary: usageSummary(levelNorm, { date: today, views: 0, downloads: 0, asks: 0 }),
      };
    }
    const record = await airtableRecord({ config, table: config.membersTable, recordId, fetchImpl, throttle: createThrottle() });
    const usage = readUsage((record && record.fields) || {}, today);
    const summary = usageSummary(level, usage);
    const remaining =
      kind === 'download'
        ? summary.downloadsRemaining
        : kind === 'ask'
          ? summary.asksRemaining
          : summary.viewsRemaining;
    if (remaining <= 0) throw quotaError({ level, kind, summary });

    if (kind === 'download') usage.downloads += 1;
    else if (kind === 'ask') usage.asks += 1;
    else usage.views += 1;

    await airtableWrite({
      config,
      table: config.membersTable,
      recordId,
      fields: {
        [USAGE_FIELDS.date]: today,
        [USAGE_FIELDS.views]: usage.views,
        [USAGE_FIELDS.downloads]: usage.downloads,
        [USAGE_FIELDS.asks]: usage.asks,
      },
      fetchImpl,
      throttle: createThrottle(),
    });
    return { level: normaliseLevel(level), usage, summary: usageSummary(level, usage) };
  }

  /**
   * Gives back the Ask AI question reserved before a Gemini call that then failed, so a network
   * error or an upstream refusal does not cost the member one of their daily questions.
   */
  async function refundAskQuota(recordId, usage) {
    if (!recordId || !usage) return;
    try {
      await airtableWrite({
        config,
        table: config.membersTable,
        recordId,
        fields: {
          [USAGE_FIELDS.date]: usage.date,
          [USAGE_FIELDS.views]: usage.views,
          [USAGE_FIELDS.downloads]: usage.downloads,
          [USAGE_FIELDS.asks]: Math.max(0, Number(usage.asks || 0) - 1),
        },
        fetchImpl,
        throttle: createThrottle(),
      });
    } catch {
      // Best effort: the answer already failed, and the next question still gets a correct count.
    }
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
    return { identity, membership: entry.value, recordId: entry.recordId, activity: entry };
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

  async function route(request, ctx) {
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
        assistant: Boolean(config.geminiApiKey),
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
      const { membership, recordId, activity } = await requireMember(request);
      await recordActivity(activity, ctx);
      const usage = await usageFor(recordId, membership.level);
      // newAccount tells the app this Google account had no Members row before this request, so
      // the referral prompt is offered once, right after a first sign-up.
      const newAccount = Boolean(activity?.justJoined);
      if (activity) activity.justJoined = false;
      return jsonResponse(
        200,
        { ...membership, newAccount, trialDays: config.inviteTrialDays, usage },
        { Vary: 'Authorization' },
      );
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

    // Invitation codes: the member's own code, and redeeming someone else's for 7 days of Pro.
    if (url.pathname === '/api/invite') {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Only GET and HEAD are supported.');
      }
      return inviteStatus(request);
    }

    if (url.pathname === '/api/invite/redeem') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Only POST is supported.');
      return redeemInvite(request);
    }

    // A member's method/document upload: stored in the uploads table for an administrator to review.
    if (url.pathname === '/api/method-uploads') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Only POST is supported.');
      return submitMethodUpload(request);
    }

    // The "Ask AI" button: a member's question about one method, answered from that row.
    if (url.pathname === '/api/documents/ask') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Only POST is supported.');
      return askDocument(request);
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

    // Review method uploads inside the app: list them, read one with Gemini, then approve or reject.
    if (url.pathname === '/api/admin/uploads') {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Only GET and HEAD are supported.');
      }
      return adminUploads(request);
    }

    const adminUploadAnalyse = /^\/api\/admin\/uploads\/([^/]+)\/analyse$/.exec(url.pathname);
    if (adminUploadAnalyse) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST to analyse.');
      return analyseUpload(request, adminUploadAnalyse[1]);
    }

    const adminUploadReview = /^\/api\/admin\/uploads\/([^/]+)\/review$/.exec(url.pathname);
    if (adminUploadReview) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST to review.');
      return reviewUpload(request, adminUploadReview[1]);
    }

    if (url.pathname === '/api/methods') {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Only GET and HEAD are supported.');
      }
      const { activity } = await requireMember(request);
      await recordActivity(activity, ctx);
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
      // Opening (view), saving (download) and printing are counted against the daily allowance.
      // Printing is charged as a download, but the PDF is not streamed again: the app already
      // has the copy it opened, so the member only spends the download slot.
      const requestedMode = String(url.searchParams.get('mode') || '').toLowerCase();
      const mode =
        requestedMode === 'download' ? 'download' : requestedMode === 'print' ? 'print' : 'view';
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
          : await consumeQuota({
              recordId: memberRecordId,
              level: membership.level,
              kind: mode === 'view' ? 'view' : 'download',
            });

      if (mode === 'print') {
        return new Response(null, {
          status: 204,
          headers: {
            'Cache-Control': 'private, no-store',
            Vary: 'Authorization',
            ...quotaHeaders(membership.level, quota.summary),
          },
        });
      }

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

  return async function handle(request, ctx) {
    try {
      return withAdminCors(request, await route(request, ctx));
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
  async fetch(request, env, ctx) {
    try {
      const config = readConfig(env);
      const key = `${config.baseId}|${config.jwksUrl}|${config.projectId}`;
      if (!cachedProxy || cachedProxyKey !== key) {
        cachedProxy = createProxy({ env });
        cachedProxyKey = key;
      }
      return await cachedProxy(request, ctx);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
