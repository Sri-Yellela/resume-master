# Resume Master Import Extension

This extension imports LinkedIn jobs into Resume Master.

Current flow:

1. Load this `extension/` folder as an unpacked extension in Chromium.
2. Open Resume Master and sign in.
3. Use the LinkedIn import button on the job board.
4. If LinkedIn login is required, complete it in the opened tab and click Import again.

Security model:

- The extension reads job data from the LinkedIn jobs page the user is already logged into.
- It sends only normalized job payloads to Resume Master.
- Tokens are fetched silently by the extension; the user never copies or pastes them.
- LinkedIn login remains in the user's own browser tab and is never copied into Resume Master.
