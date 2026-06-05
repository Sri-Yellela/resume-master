# Resume Master - Chrome Extension v1.1

Companion extension for Resume Master. Lightweight, privacy-first.

## What It Does
- ATS Score: on supported job listings, click the floating button to send the visible job description to Resume Master's ATS scoring tool.
- LinkedIn Import: opens the secure LinkedIn OAuth consent flow so you can import your name and email to pre-fill your resume.
- Quick Access: open the resume builder from anywhere.

## What It Does NOT Do
- Does not scrape, read, or collect any profile data.
- Does not auto-apply to any jobs.
- Does not store any data.
- Does not run in the background without user interaction.
- Does not request access to pages you are not currently viewing.

## Permissions Explained
- activeTab: reads the page you are on only when you click the extension button.
- scripting: lets the popup collect visible page text from the active tab after you click ATS Score Tool.

## Install (Development)
1. Chrome -> chrome://extensions -> Enable Developer Mode.
2. Load Unpacked -> select this folder.

## Privacy
This extension collects no personal data. Job description text is sent to Resume Master only when you explicitly click Send to Resume Master. See resumemaster.one/privacy for the full policy.
