// The top bar's chrome: what was removed, what only MOVED, and what had to stay put.
//
// The risk in this one is the unread count. Moving notifications into the profile menu is only
// safe if the fact that there ARE unread ones survives the move — otherwise they become invisible
// until someone happens to open a menu, which is strictly worse than the bell that was there.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const topBar = read("client/src/components/TopBar.jsx");
const usb    = read("client/src/components/UnifiedSearchBar.jsx");

const stripComments = (t) => t
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*(?:\/\/|\*).*$/gm, "");

const topBarCode = stripComments(topBar);

test("quick actions is gone entirely, not hidden", () => {
  // A ⚡ button opening three items: "Search new role" and "ATS sort", which both only navigated to
  // the jobs tab — the same thing the JOBS tab beside them already did, and neither searched nor
  // sorted anything — and "Export PDF", which called window.print() on the whole app chrome.
  // Nothing is preserved elsewhere because there was no behaviour to preserve.
  assert.ok(!/function QuickActions/.test(topBarCode), "the QuickActions component is back");
  assert.ok(!/<QuickActions/.test(topBarCode), "QuickActions is rendered again");
  assert.ok(!/Quick actions|Quick Actions/.test(topBarCode), "the quick-actions control is back");
  assert.ok(!/window\.print\(\)/.test(topBarCode), "the Export PDF action is back");
});

test("notifications moved INTO the profile menu, whole", () => {
  // Not a reduced version: the list, the per-item unread dot, the type icons, the relative
  // timestamps and mark-all-read all came across.
  assert.ok(!/function NotificationsBell/.test(topBarCode), "the standalone bell is back in the bar");
  assert.match(topBar, /function useNotifications\(\)/);
  assert.match(topBar, /function NotificationsSection\(/);
  // Rendered inside the avatar menu's dropdown, not beside it in the bar.
  const menu = topBar.slice(topBar.indexOf("function UserAvatarMenu"));
  assert.match(menu, /<NotificationsSection theme=\{theme\} notifs=\{notifs\} unread=\{unread\} markAll=\{markAll\}\/>/);
  // Everything the bell did:
  assert.match(topBar, /api\("\/api\/notifications"\)/);
  assert.match(topBar, /api\("\/api\/notifications\/read-all", \{ method: "PATCH" \}\)/);
  assert.match(topBar, /Mark all read/);
  assert.match(topBar, /No notifications yet/);
  assert.match(topBar, /NOTIF_TYPE_ICONS/);
  assert.match(topBar, /notifTimeAgo/);
  // Live updates still arrive while the menu is closed.
  assert.match(topBar, /notification:\s*\(\) => setUnread\(n => n \+ 1\)/);
});

test("the unread count stays OUTSIDE the menu, on the avatar", () => {
  // This is the load-bearing half of the move. Same "9+" cap the bell used.
  const menu = topBar.slice(topBar.indexOf("function UserAvatarMenu"));
  const trigger = menu.slice(0, menu.indexOf("<DockPortal"));
  assert.match(trigger, /\{unread > 0 && \(/, "the avatar carries no unread badge");
  assert.match(trigger, /\{unread > 9 \? "9\+" : unread\}/);
  // And it is announced, not just painted — the badge itself is aria-hidden, so the count has to
  // reach assistive tech through the button's own label.
  assert.match(trigger, /aria-label=\{unread > 0/);
  assert.match(trigger, /unread notification\$\{unread === 1 \? "" : "s"\}/);
  // One source of truth for both renderings: the hook. A second counter could disagree with the
  // list it is supposed to be summarising.
  assert.match(menu, /const \{ notifs, unread, load: loadNotifs, markAll \} = useNotifications\(\);/);
});

test("the profile menu kept everything it already had", () => {
  // Notifications were inserted into this menu, not swapped in for something.
  const menu = topBar.slice(topBar.indexOf("function UserAvatarMenu"));
  for (const kept of [/PROFILE/, /Job Profile/, /Manage Job Profiles/, /<ProfileSelectorDropdown/,
                      /Accent Color/, /Sign Out|onLogout/]) {
    assert.match(menu, kept, `the profile menu lost ${kept}`);
  }
});

test("the app logo is glass, and the marketing mark is left alone", () => {
  // It was an opaque white block with a 2.5px black border and black italic text — the one element
  // on a dark translucent bar that did not belong to it.
  const logo = topBar.slice(topBar.indexOf("function AnimatedLucyLogo"), topBar.indexOf("// ── Dock divider"));
  assert.ok(!/background: "#ffffff"/.test(logo), "the solid white stamp is back in the app bar");
  assert.ok(!/2\.5px solid #0f0f0f/.test(logo), "the heavy black border is back");
  assert.ok(!/color: "#0f0f0f"/.test(logo), "the logo text is black again, on a dark bar");
  assert.match(logo, /background: "rgba\(255,255,255,0\.06\)"/);
  assert.match(logo, /border: "1px solid var\(--border-glass/);
  assert.match(logo, /backdropFilter: "blur\(8px\)"/);
  // The rotation is the mark's character and was never the problem.
  assert.match(logo, /transform: "rotate\(-2deg\)"/);

  // StampLogo is the MARKETING mark (NavBar + landing hero). It sits on photography rather than on
  // the app's glass, where the solid stamp is doing a job it was not doing here, so it is
  // deliberately untouched.
  const stamp = read("client/src/components/StampLogo.jsx");
  assert.match(stamp, /background: '#ffffff'/);
});

test("the tab row's vertical rhythm matches the bar's horizontal spacing", () => {
  // Measured before at 1440x900: 21px above the tab text and 0px between it and the search field —
  // the tabs were pressed against the input with all the air on the wrong side. The row's own
  // padding was "8px 12px 0", which added above and contributed nothing below.
  // After: 21px above, 21px below, against 20px card padding on the left and right.
  assert.ok(!/padding: "8px 12px 0", alignItems: "center"/.test(usb),
    "the tab row is top-heavy again");
  assert.match(usb, /padding: "0 12px 10px", marginBottom: 10, alignItems: "center"/);
});
