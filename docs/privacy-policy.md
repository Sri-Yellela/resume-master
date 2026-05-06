# Resume Master Importer Privacy Policy

Effective date: May 1, 2026

This privacy policy describes the Chrome extension named **Resume Master Importer**. It covers only the browser extension and the extension-specific data flows used to import visible LinkedIn job listings into Resume Master. The broader Resume Master web application may handle additional account, resume, job-search, application, billing, or integration data outside the scope of this extension-specific policy.

TODO: Add the legal operator name, support email address, and public production application URL before submitting this policy URL to the Chrome Web Store.

## What the Extension Does

Resume Master Importer connects a signed-in Resume Master browser tab with LinkedIn Jobs pages. When the user starts an import from Resume Master, the extension opens a LinkedIn job search page for the user's active Resume Master job profile, reads visible job cards from that LinkedIn page, and sends normalized job listing data back to the user's Resume Master account.

The extension does not create a separate extension account. It relies on the user's existing Resume Master web session and an extension auth-context token issued by the Resume Master backend.

## Information the Extension Handles

Based on the current extension and backend implementation, the extension handles the following categories of information.

### Resume Master Account and Connection Information

The extension asks the Resume Master app tab for the signed-in user's authentication status through `/api/auth/me`. The response currently includes account information such as the user's internal user ID, username, admin flag, apply mode, plan tier, allowed modes, capabilities, and whether the domain profile is complete.

The extension displays the username, or a fallback account label, in the extension popup and Resume Master integration UI to show connection status. The extension code also supports displaying an email value if the backend provides one in the future.

### Authentication and Session Data

The extension uses the browser `cookies` permission to inspect cookies for the detected Resume Master app domain. It looks for an authentication or session cookie name and may use a matching cookie value if it is usable. If that cookie value is not usable for extension import requests, the extension requests an auth-context token from `/api/auth/extension-token`.

The backend stores only a hash of each issued auth-context token, associated with the user ID, creation time, last-seen time, expiration time, and user-agent label. Extension auth-context tokens are issued with the user-agent label `resume-master-extension` and expire after seven days unless revoked or cleaned up. The extension sends the token as a `Bearer` token when importing LinkedIn jobs.

The Resume Master web session cookie is configured by the backend as `httpOnly`, `sameSite: "lax"`, and `secure` when `NODE_ENV` is `production`. The session cookie max age is seven days and rolls forward on server requests.

### Active Job Profile Information

The extension requests the user's active Resume Master job profile through `/api/auth/active-profile`. The response includes the active profile ID, target role/profile name, and location. The target role and location are used to build the LinkedIn job search URL. The active profile ID is sent with imported job listings so Resume Master can associate the import with the user's active profile context.

### LinkedIn Job Listing Data

When the user starts an import, the extension reads visible job cards from LinkedIn Jobs pages matching `https://www.linkedin.com/jobs/*`. It extracts the following fields when available:

- LinkedIn external job ID from the job URL.
- Job URL.
- Apply URL.
- Job title.
- Company name.
- Location.
- Posted-at text.
- Source platform value of `linkedin`.

The extension imports up to 250 visible jobs per import run. It does not read LinkedIn private messages, contacts, profile data, saved passwords, or the contents of pages outside the LinkedIn Jobs match pattern declared in the manifest.

### Import Status and Error Information

The extension tracks transient status needed to run and display imports, including connection status, imported job count, error messages, Resume Master app URL, and the LinkedIn tab ID opened for an import.

## Where Information Comes From

The extension receives information from these sources:

- The Resume Master web application tab, through the injected app bridge and same-origin app API requests.
- The Resume Master backend APIs used by the signed-in user.
- Visible LinkedIn Jobs page content in the user's browser.
- Browser cookie metadata and cookie values for the detected Resume Master app domain.
- User actions in the Resume Master UI and extension popup, such as starting an import, retrying an import, opening Resume Master, or disconnecting extension tokens.

## How the Extension Uses Information

The extension uses information only to support the LinkedIn job import workflow:

- To confirm that the user is signed in to Resume Master.
- To obtain an auth-context token or usable session credential for import requests.
- To open a LinkedIn Jobs search page based on the active Resume Master profile's target role and location.
- To read visible LinkedIn job cards selected by the user's current browser context.
- To send normalized job listing data to Resume Master for storage in the user's account.
- To display connection, import, completion, retry, and error status.
- To close the LinkedIn import tab after completion when requested by the app workflow.

## Information Sent to Resume Master

The extension sends imported LinkedIn job listings to:

`POST /api/jobs/import`

The request includes a `Bearer` auth-context token and a JSON body containing the source value `linkedin`, the active profile ID when available, and an array of job listing objects. The job objects may include title, company, location, job URL, apply URL, external job ID, posted-at text, and source platform.

The backend normalizes imported jobs and stores them in the `imported_jobs` table with fields including user ID, source key, source label, source platform, external job ID, dedupe key, title, company, location, job URL, apply URL, work type, employment type, compensation, posted-at text, description, company icon URL, original payload JSON, flags such as visited/starred/disliked/applied, import count, and import timestamps. For the current LinkedIn extension scraper, description, compensation, company icon URL, work type, and similar optional fields are generally not collected unless present in a submitted payload.

The backend deduplicates imported jobs per user, source, and dedupe key. On duplicate imports, it updates the existing imported-job record and increments the import count.

## Browser Storage

The extension uses `chrome.storage.session` with the key `rmExtensionState`. The stored session state may include:

- `status`
- `userEmail`, which currently receives the Resume Master username or a generic fallback unless the backend provides an email field
- `importedCount`
- `error`
- `appUrl`
- `linkedInTabId`

This storage is used for extension UI state and app-to-extension coordination. The extension does not use `chrome.storage.local` or `chrome.storage.sync` in the current implementation.

The extension also keeps some runtime-only state in memory, including the Resume Master app tab ID, LinkedIn tab ID, app URL, and last import request. Runtime state is not intentionally persisted by the extension.

## Backend Storage and Retention

Imported jobs are persisted in the Resume Master backend database under the signed-in user's account. The current code stores import timestamps and keeps imported-job rows unless they are later changed or removed by application functionality or database maintenance.

Auth-context token hashes are stored by the backend with creation, last-seen, expiration, and revocation metadata. The code issues these tokens with a seven-day expiration and deletes expired or revoked auth-context rows during token issuance cleanup.

TODO: Confirm and publish the operator's formal retention schedule for imported jobs, account records, logs, backups, and production database retention. The repository does not contain a complete business retention policy.

## Cookies and Identifiers

The extension can read cookies for the Resume Master app domain because it declares the `cookies` permission. It uses this access to detect and use an existing Resume Master session where possible. The extension does not set LinkedIn cookies, does not copy LinkedIn cookies into Resume Master, and does not store LinkedIn login cookies.

The extension sends an auth-context token to Resume Master as a `Bearer` token for import requests. The backend stores a hash of that token, not the raw token, in the auth-context database table.

## Third Parties and Infrastructure

The extension interacts with:

- LinkedIn Jobs pages, where the user is already browsing and where visible job listing data is read.
- The Resume Master web application and backend API.
- Production Resume Master hosts matching the extension manifest pattern `https://*.up.railway.app/*`.
- Local development hosts `http://localhost:3001/*` and `http://127.0.0.1:3001/*`, which are present in the manifest for development and testing builds.

The repository also contains backend integrations for services such as Anthropic, Google OAuth, LinkedIn OAuth, Resend, Apify user tokens, and optional infrastructure mentioned in deployment comments. Those services are part of the broader Resume Master application and are not directly called by the Chrome extension's LinkedIn import code path, except that the extension communicates with the Resume Master backend that may run on Railway-hosted infrastructure.

TODO: Confirm the production hosting provider, production domain, and any subprocessors used for the production Resume Master service before publishing a complete company-wide privacy policy.

## Sale or Sharing of Data

The current extension code does not contain advertising, analytics SDKs, telemetry SDKs, data broker integrations, or code that sells imported LinkedIn job data.

TODO: Confirm the operator's business practice for data sale, advertising use, and cross-context behavioral advertising. The repository code does not by itself prove business commitments outside the software implementation.

## Security

For production hosts covered by `https://*.up.railway.app/*`, extension-to-backend import requests use HTTPS. The backend also marks session cookies as secure in production. Auth-context tokens are sent only to the configured Resume Master app URL and are stored on the backend as hashes.

Local development hosts in the manifest use HTTP for local testing only. They should not be used as the public production service URL in Chrome Web Store listing materials.

No security method can guarantee absolute protection. Users should install the extension only from the official Chrome Web Store listing and use it only with the intended Resume Master service.

## User Choices and Controls

Users can:

- Choose whether to install or remove the Chrome extension.
- Start a LinkedIn import manually from Resume Master.
- Avoid importing by not clicking the LinkedIn import action.
- Disconnect the LinkedIn importer from Resume Master through the Resume Master integrations UI, which calls `/api/auth/revoke-extension-token`.
- Clear extension session state through the extension session-clear flow implemented in the extension message handler.
- Remove the extension through Chrome.

TODO: Confirm whether the production app exposes user-facing deletion controls for imported jobs and account deletion, and document those controls here.

## Chrome Extension Permissions

The extension requests these permissions for the LinkedIn import workflow:

- `activeTab`: to work with the current user-initiated browser context.
- `storage`: to store transient extension status in `chrome.storage.session`.
- `tabs`: to open the LinkedIn job search tab, detect LinkedIn login/checkpoint pages, close the import tab, and coordinate with the Resume Master app tab.
- `cookies`: to detect the Resume Master session for the app domain and connect the extension to the signed-in account.
- `scripting`: to inject the app bridge or LinkedIn content script into already-open matching tabs during extension installation.

The extension requests host access for:

- `https://www.linkedin.com/*`: to run the LinkedIn Jobs content script and read visible job listing cards.
- `https://*.up.railway.app/*`: to connect with deployed Resume Master app instances matching this host pattern.
- `http://localhost:3001/*` and `http://127.0.0.1:3001/*`: to support local development and testing.

## Chrome Web Store User Data Statement

The extension's single purpose is to import visible LinkedIn job listings into the user's Resume Master account. Extension-handled data is used to provide that import workflow and related connection/status UI.

The current extension code does not use extension-handled data for advertising, creditworthiness, unrelated profiling, or resale. The extension does not include remote-code loading, obfuscated extension logic, analytics SDKs, or telemetry SDKs in the current extension folder.

The extension sends job listing data and auth-context credentials only to the configured Resume Master app URL needed to perform the import. This statement is limited to the behavior visible in the current repository and should be reviewed again before each Chrome Web Store release.

## Children's Privacy

Resume Master Importer is intended for people using Resume Master for job-search workflows. It is not directed to children under 13.

## Changes to This Policy

This policy should be updated when the extension's permissions, host access, data flows, backend endpoints, storage behavior, or production subprocessors change. The effective date above should be updated when material changes are published.

## Contact

TODO: Add the support email address, legal operator name, mailing address if required, and any jurisdiction-specific privacy contact details.
