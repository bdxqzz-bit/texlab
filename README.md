# TexLab (Android)

An Android app for a textile testing laboratory: members sign in with Google, browse the
method library stored in Airtable, read the method PDF inside the app, and save it to the
device. Access is restricted to Google accounts that appear on the Airtable member list.

The app never holds an Airtable credential. It talks to a small proxy (`worker/`, deployed on
Cloudflare Workers) that verifies the Firebase ID token, checks the member list and only then
reads the base or streams a PDF, so the member restriction is enforced outside the APK.

```
Android app ──Firebase ID token──▶ proxy server ──AIRTABLE_TOKEN──▶ Airtable
   │                                   │
   └────── methods JSON, PDF bytes ────┘   (member check + token live here)
```

## What it does

| Area | Implementation |
| --- | --- |
| Sign-in | Google identity through AndroidX Credential Manager, exchanged for a Firebase Authentication session |
| Member restriction | The proxy verifies the Firebase ID token, then looks up the token's email in the Airtable `Members` table; the app gets no data at all unless that row is active |
| Method library | Proxy returns the merged Airtable method tables, searchable by name/code/standard, filterable by category, refresh from the toolbar |
| PDF viewing | In-app viewer using the platform `PdfRenderer`, pages rendered lazily while scrolling |
| PDF download | Streamed through the proxy, cached, exported to `Downloads/TexLab/` (Android 10+) |
| Sharing | System share sheet through `FileProvider` |

Minimum Android 8.0 (API 26), target/compile SDK 35, Kotlin + Jetpack Compose (Material 3).
The proxy runs on Cloudflare Workers (`worker/`) and, for local development, as dependency-free
Node.js 20+ (`server/`).

## 1. Firebase (Google sign-in)

The project uses the Firebase project `android-49288` (`app/google-services.json`, Android app
package `com.bdx.texlab`) and the official `com.google.gms.google-services` Gradle plugin, so
`applicationId` must stay `com.bdx.texlab`.

`app/google-services.json` already contains the Android OAuth client (with the debug SHA-1
certificate hash) and the web OAuth client, so the app reads its client id from the generated
`default_web_client_id` resource. In the Firebase console, make sure **Authentication →
Sign-in method → Google** is enabled with a support email, and register the SHA-1 of the
keystore you actually build with (**Project settings → Your apps → `com.bdx.texlab` → Add
fingerprint**; `./gradlew :app:signingReport`, look at `Variant: debug`). Without the matching
fingerprint Google rejects the sign-in request.

If you use a different Firebase project, download its `google-services.json` and replace
`app/google-services.json`, and set `FIREBASE_PROJECT_ID` for the proxy to that project's id.
You can also supply the Web client id manually in `local.properties` (it overrides the generated
resource):

```properties
GOOGLE_WEB_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
```

`google-services.json` is committed on purpose: it holds no secret.

## 2. Proxy (Cloudflare Worker)

The proxy is the only component that knows the Airtable token, and it keeps it as a Worker
secret. It has no npm dependencies and no Node built-ins (WebCrypto plus Google's JWKS
endpoint), so it runs on the Workers free tier.

**Deployed:** `https://texlab-proxy.bdxqzz.workers.dev` — the Worker `texlab-proxy` on the
project owner's own Cloudflare account (workers.dev subdomain `bdxqzz`, Workers free plan).
`AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` are Worker secrets there. That URL is what
`PROXY_BASE_URL` uses.

```bash
cd worker
npm install                              # wrangler (dev tooling only)
npm test                                 # 40 checks: tokens, levels, join, profile sync, PDF, push
npx wrangler dev                         # local workerd on http://127.0.0.1:8787
npx wrangler secret put AIRTABLE_TOKEN    # then npx wrangler deploy (your own account)
```

| Worker setting | Where | Value |
| --- | --- | --- |
| `AIRTABLE_TOKEN` | Worker secret | PAT with `data.records:read,data.records:write` and the base added |
| `AIRTABLE_BASE_ID` | secret, or a var in `wrangler.jsonc` | `appbl0HDJ4cbQES5h` |
| `AIRTABLE_METHODS_TABLE`, `AIRTABLE_MEMBERS_TABLE`, `MESSAGES_TABLE`, `FIREBASE_PROJECT_ID`, `MEMBERSHIP_CACHE_SECONDS` | vars | same meanings as the Node server below |

`server/index.mjs` keeps the same endpoints, token checks and member gate for local work
(`node server/index.mjs`, `node server/selftest.mjs`).

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness check, no token needed |
| `GET /api/me` | `{member, level, levelLabel, name, firstName, lastName, photoUrl, role, usage}`; a first-time account joins here as Basic, an inactive row gets `403 not_a_member`, `usage` is today's allowance |
| `GET /api/methods` | Merged, sorted method list with proxy-relative PDF URLs |
| `GET /api/files/{table}/{recordId}/{attachmentId}?mode=view\|download` | Streams the PDF and charges one view (default) or one download; over the limit it answers `429 quota_exceeded` with a readable message |

Every `/api/*` request needs `Authorization: Bearer <Firebase ID token>`. The server checks the
RS256 signature against Google's published certificates, the issuer and audience
(`FIREBASE_PROJECT_ID`), expiry, subject and that the email is verified. Only then does it query
Airtable: the Airtable token stays in the Worker, so the app — or a patched APK — has no
credential to extract.

**Joining, levels and profile sync.** Any verified Google account may sign in, so the library is
no longer a closed allowlist. The first request from an email that is not in `Members` creates a
row there with `Level` = `Basic`, `Status` = `Active`, and the `Name`, `First name`, `Last name`
and `Photo` URL taken from the Google profile claims in the ID token (`given_name`,
`family_name`, `picture`). An existing row keeps its own level — `Basic`, `Pro` or `Max` — and is
filled in from the profile when those columns are empty. A row whose `Status` is `Pending` or
`Revoked` is not re-created and stays locked out.

**Daily allowances.** Each level may open and save so many PDFs per day (UTC, resetting at
00:00 UTC):

| Level | PDF views / day | PDF downloads / day |
| --- | --- | --- |
| `Basic` (every new Google account) | 5 | none |
| `Pro` | 20 | 5 |
| `Max` | 50 | 20 |

The counters live on the member's own row (`Usage date`, `Views today`, `Downloads today`) and
are checked and incremented by the Worker before any PDF byte is sent, so clearing the app's
cache, a patched APK or a copied ID token cannot get around them. A view is charged when the
method page's **View** opens a PDF; a download when **Download** saves one. `/api/me` and every
PDF response report the remaining allowance (`usage`, and `X-Quota-*` headers) so the app can
show it, and an exhausted allowance answers `429 quota_exceeded` naming the limit and the reset
time. Raise a member's allowance by setting `Level` to `Pro` or `Max` in the Members table.

`AIRTABLE_TOKEN` therefore needs `data.records:read` **and** `data.records:write`. If write is
missing, sign-in for existing members still works and a new account gets a readable
`502 airtable_write_error`.

### Notifications and the admin console

An administrator sends a push from the console built into the app and it arrives in the TexLab
notification channel on the phones of the members they selected. A device only receives anything
after its member turns **Lab notifications** on in the app; that switch is what registers the
device token on the member's Airtable row, and signing out or switching it off removes it again.

**One-time Cloud Messaging setup.**

1. Google Cloud console (project `android-49288`) → APIs & Services → enable **Firebase Cloud
   Messaging API**.
2. Firebase console → Project settings → Service accounts → **Generate new private key**. Keep
   that JSON file out of the repository.
3. Give it to the Worker as one secret (it signs its own OAuth token from it, so nothing has to be
   minted by hand and no FCM credential ships in the APK):

   ```bash
   cd worker
   npx wrangler deploy
   npx wrangler secret put FCM_SERVICE_ACCOUNT     # paste the whole service-account JSON
   npx wrangler secret put ADMIN_ORIGIN            # optional: an extra allowed origin, default *
   ```

**Admin endpoints** (all need `Authorization: Bearer <Firebase ID token>` and a member whose `Role`
is `Admin`, `Administrator`, `Owner` or `Manager`):

| Endpoint | Purpose |
| --- | --- |
| `POST /api/messages` | `{kind, subject, message, appVersion, device}` — stores one report or request from the signed-in member in the Messages table |
| `POST /api/documents/ask` | `{methodId, question, history}` — answers a question about that method with Gemini, grounded in its attached PDF |
| `GET /api/notifications/me` | The signed-in member's own push state (token shown as a short preview) |
| `POST /api/notifications/register` | `{token, appId}` — stores this device on the member's row |
| `POST /api/notifications/unregister` | Clears the device from the row (switch off / sign out) |
| `GET /api/admin/messages` | The member inbox: reports and requests sent from the app, newest first |
| `GET /api/admin/members` | Member list with level, role, status, push state and today's usage |
| `POST /api/admin/members/{recordId}/push-token`, `DELETE …` | Sets or clears one member's device token |
| `GET /api/admin/notify` | Whether push is configured on the Worker |
| `POST /api/admin/notify` | `{title, body, targetMode, targetLevel, suppressedEmails}` — sends one push per reachable device |

`targetMode` is `all members`, `opt-in only`, `admin only` or `level` (with `targetLevel`);
`suppressedEmails` is a comma-separated list to leave out, which is how the console sends to
"selected members only". One send is capped by `MAX_NOTIFICATIONS_PER_SEND` (default 100).

**Reports and requests.** The home screen's 3-dot menu opens **Report or request**, a form a
member fills in (Report a problem / Request, optional subject, message). It is submitted through
`POST /api/messages`, which writes the row to the `Messages` table with the author taken from the
verified ID token — no email app is opened and nothing leaves the app's own server. The admin
console lists those rows under **Member messages**, newest first, with the kind, subject, message,
member and app/device details. The Worker never writes to a row after creating it, so `Status` is
edited in Airtable as messages are handled.

**Ask AI on a document.** Every method's detail screen has an **Ask AI** button. It opens a chat
about that method only: the question goes to `POST /api/documents/ask` with the method's record
id. The Worker fetches the PDF attached to that row and sends it to Gemini as an inline PDF part,
so answers are grounded in the document's own text, and adds the row's short text columns (title,
name, scope, standard, year) as extra context. The file stays in the Worker's memory for ten
minutes so follow-up questions do not re-download it, and is never sent to the app or stored. The
app holds no AI credential and the answer is never stored. Without the key the route answers
`500 gemini_not_configured` and the rest of the app is unaffected.

```bash
cd worker
npx wrangler secret put GEMINI_API_KEY     # a Google AI Studio key from https://aistudio.google.com/apikey
```

`GEMINI_MODEL` (default `gemini-3.1-flash-lite`) picks the model; older flash models such as
`gemini-2.5-flash` are retired for new API keys. Only the last eight chat turns are
replayed to the model, and a question is capped at 1000 characters.

**Ask AI limits.** Each level gets a daily number of questions — Basic 5, Pro 20, Max 40 —
counted in the `Ask AI today` column on the member row next to the view and download counters,
reset at 00:00 UTC. A question is reserved before the Gemini call and refunded if the call fails.
On top of that, the question goes through a per-isolate sliding-minute cap (`GEMINI_RPM`, default
10) and one in-flight question per member, so the free tier's rate limit is not tripped and the
key cannot be spammed; a refused call returns `429 assistant_busy` with `Retry-After`.

**Sending from the app.** The console is built into the app: a member whose `Role` is one of the
admin roles gets a console icon in the home screen's top bar, and every other role never sees it
(the screen itself also refuses to render, and the proxy re-checks the role on each admin
request, so the hidden button is the first of three gates). It lists the members with their level
and whether a device is registered, and sends to the ticked members, everyone, admins only or a
single level. Nothing extra has to be hosted or configured: the app is already signed in.

### Node server (local use)

Configure it with `server/.env` (git-ignored), or with real environment variables — those win:

```bash
cp server/.env.example server/.env      # then fill in AIRTABLE_TOKEN and AIRTABLE_BASE_ID
node server/index.mjs                   # http://0.0.0.0:8080
node server/selftest.mjs                # 16 checks: token checks, member gate, PDF streaming
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `AIRTABLE_TOKEN` | required | Personal access token with `data.records:read` and the base added to its access list |
| `AIRTABLE_BASE_ID` | required | `app…` id from the base URL, currently `appbl0HDJ4cbQES5h` |
| `AIRTABLE_METHODS_TABLE` | `ISO,AATCC` | Comma-separated method tables; the table name is the category when a record has no `Category` |
| `AIRTABLE_MEMBERS_TABLE` | `Members` | Allowlist table |
| `MESSAGES_TABLE` | `Messages` | Member reports and requests shown in the admin console |
| `FIREBASE_PROJECT_ID` | `android-49288` | Project whose ID tokens are accepted |
| `PORT` | `8080` | Listen port (most hosts set this) |
| `MEMBERSHIP_CACHE_SECONDS` | `300` | How long a member lookup is cached; lower it for faster revocation |

The app refuses cleartext HTTP except to `localhost`/`10.0.2.2` (see
`app/src/main/res/xml/network_security_config.xml`), so whatever the APK talks to must be HTTPS.
Keep the Airtable token in the host's secret store (Worker secret, `server/.env`, environment
variable), never in a committed file.

### Airtable schema

**Method tables** (`ISO`, `AATCC`) — `Method` (title), `Method Name`, `Scope`, `Version`,
`File` (attachment). Field names are flexible: `Name`, `Title`, `Description`, `Code`,
`Standard` and any attachment field are detected too.

**Messages** (`Messages`) — `Email` (single line text, the author from the verified token),
`Name`, `Kind` (single select `Report`/`Request`), `Subject`, `Message` (long text),
`App version`, `Device`, `Status` (single select, `New` when written), `Submitted at` (ISO
timestamp). The Worker creates rows here and reads them for the admin console; it needs
`data.records:read` and `data.records:write` on this table like the Members table. If the table is
missing, `POST /api/messages` answers `502 airtable_error` naming the table.

**Members** (`Members`) — `Email` (must match the Google account), `Name`, `First name`,
`Last name`, `Photo` (url), `Level` (single select `Basic`/`Pro`/`Max`), `Status`, `Role`, and the
daily counters `Usage date` (single line text, `YYYY-MM-DD`), `Views today` and
`Downloads today` (numbers). Without the three counter columns PDFs fail closed with
`502 quota_store_error`, because the allowance cannot be recorded.
Rows are created automatically on first sign-in as Basic with the Google name and photo; raise a
member by setting `Level` to `Pro` or `Max`. Active values: `Active`, `Approved`, `Member`,
`Paid`, `Yes`, `1`, `True`, `Current`, `Enabled`. A row without a `Status` column counts as
active; `Pending`, `Revoked`, `Inactive` block access. Revoke by changing the status or deleting
the row — after at most `MEMBERSHIP_CACHE_SECONDS`, with no app build.

## 3. Build and run

```bash
cp local.properties.example local.properties   # set PROXY_BASE_URL and SUPPORT_EMAIL
./gradlew :app:assembleDebug                   # build the APK
./gradlew :app:installDebug                    # install on a connected device
```

`PROXY_BASE_URL` is the only server setting the app needs. It currently points at
`https://texlab-proxy.bdxqzz.workers.dev`; use `http://10.0.2.2:8080` to reach
the Node server on the same computer from the Android emulator.
`local.properties` is git-ignored and the same keys are read from environment variables of the
same name, so CI can inject them. If a value is missing the app opens a **Configuration needed**
screen instead of failing at sign-in.

APK output: `app/build/outputs/apk/debug/app-debug.apk`.

## How the member restriction works

1. Credential Manager returns a Google ID token, exchanged for a Firebase session.
2. Every request sends the current Firebase ID token (refreshed by the SDK when needed).
3. The proxy verifies the token, then queries Airtable `Members` with
   `LOWER({Email})='<token email>'`.
4. Not a member → `403 not_a_member`; the app signs out and shows "No member access". No method
   data or PDF bytes are ever sent to that account.
5. PDF URLs point back at the proxy, not at Airtable's CDN, and the proxy re-checks membership
   before streaming each file. Sign-out clears the cached PDFs on the device.

## Security notes

- The Airtable token exists only as a Worker secret (or the Node server's environment). Nothing
  in the APK can read the base directly, so the gate is a real secret boundary and not just UI.
- Tokens are checked server-side on every request; there is no client-supplied email or role.
- Member lookups are cached briefly for Airtable's 5 requests/second limit. Reduce
  `MEMBERSHIP_CACHE_SECONDS` if revocation must take effect immediately.
- Airtable attachment URLs are pre-signed and expire after a few hours; the proxy reads the
  record at download time, so links never go stale, and it never exposes those URLs.
- CORS is not opened up, responses are `no-store`/`private`, and only `GET` is accepted.
- Release builds enable R8 minification and resource shrinking.

## Project layout

```
worker/
├── index.mjs                    Proxy: Firebase token verification + member gate + Airtable
├── selftest.mjs                 19-check self-test (throwaway keys, stubbed Airtable)
├── wrangler.jsonc               Worker name, compatibility date, non-secret vars
├── sites.manifest.json          Deployment manifest for the hosted Worker
└── .dev.vars.example            Local secrets for `wrangler dev`
server/
├── index.mjs                    Same proxy for local Node (no npm dependencies)
├── selftest.mjs                 16-check self-test
└── .env.example                 Configuration
app/google-services.json         Firebase project config (package com.bdx.texlab)
app/src/main/java/com/bdx/texlab/
├── MainActivity.kt              Compose entry point
├── TexLabApplication.kt         Application: AppConfig.init
├── auth/AuthRepository.kt       Credential Manager + Firebase sign-in, ID token provider
├── data/AppConfig.kt            Proxy URL, Firebase readiness checks
├── data/ProxyClient.kt          Authenticated calls to the proxy (methods, member, PDF)
├── data/Models.kt               TestMethod, PdfAttachment, MembershipResult
├── pdf/PdfStore.kt              Cache, Downloads export, share intent
├── pdf/PdfDocument.kt           Thread-safe PdfRenderer wrapper
├── pdf/PdfViewer.kt             Lazy scrolling PDF pages
├── ui/AppViewModel.kt           Auth/membership/library/download state
├── ui/TexLabApp.kt             Gate + navigation
└── ui/screens/                  Sign-in, library, viewer, setup screens
```
