# Resume Master Import Extension

This extension imports a user's own LinkedIn saved jobs into Resume Master.

Current flow:

1. Open Resume Master and generate a short-lived LinkedIn import token from the Jobs panel.
2. Load this `extension/` folder as an unpacked extension in Chromium.
3. Open `https://www.linkedin.com/my-items/saved-jobs/`.
4. Open the extension popup, paste the token, and run the import.

Security model:

- The extension reads job data from the page the user is already logged into.
- It sends only normalized job payloads to Resume Master.
- LinkedIn cookies are not copied into the app backend.
- The app import token is short-lived and scoped to the LinkedIn saved-jobs import route.
