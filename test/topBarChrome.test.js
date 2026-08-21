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

// THE LOGO IS WHITE, AND THIS TEST USED TO ASSERT THE OPPOSITE.
//
// W6 made the app mark translucent — `rgba(255,255,255,0.06)` behind a `--border-glass` hairline,
// with `theme.text` / `theme.textMuted` glyphs — and locked that in here with three negative
// assertions ("the solid white stamp is back in the app bar"). Those assertions were the reason
// the regression was safe to keep: the mark had no edge of its own on a top bar that is fully
// transparent at rest, and the guard said that was correct.
//
// Read from `topBarCode`, not `topBar`: the component now carries a comment quoting the very
// literals under test, and matching a comment instead of code is how a source-string test passes
// while the code says something else.
const logoOf = (src) => {
  const start = src.indexOf("function AnimatedLucyLogo");
  const end = src.indexOf("function Divider", start);
  assert.ok(start >= 0 && end > start, "AnimatedLucyLogo / Divider boundary moved");
  return src.slice(start, end);
};

test("the app logo is the WHITE stamp, matching the marketing mark", () => {
  const logo = logoOf(topBarCode);

  // The mark itself.
  assert.match(logo, /background: "#ffffff"/, "the app mark is not white");
  assert.match(logo, /border: "2\.5px solid #0f0f0f"/, "the stamp border is not the mark's border");
  assert.match(logo, /borderRadius: 2\b/, "the stamp corner radius is not the mark's");
  // BOTH glyph spans are the stamp's black — the leading "R" and the collapsing remainder. W6 split
  // them into text/textMuted, which is what made the mark read as two-tone.
  assert.equal((logo.match(/color: "#0f0f0f"/g) || []).length, 2,
    "both logo spans should carry the stamp's black");

  // The glass treatment is gone, including the two things that came with it: a backdrop blur with
  // nothing to blur behind an opaque fill, and a hover transition that was never wired to a
  // mouse handler.
  assert.ok(!/rgba\(255,255,255,0\.06\)/.test(logo), "the translucent fill is back");
  assert.ok(!/--border-glass/.test(logo), "the glass hairline is back on the app mark");
  assert.ok(!/backdropFilter/.test(logo), "the backdrop blur is back behind an opaque fill");
  assert.ok(!/transition: "background/.test(logo), "the unwired hover transition is back");

  // The rotation is the mark's character and is untouched in either direction.
  assert.match(logo, /transform: "rotate\(-2deg\)"/);
});

test("the logo's own container does not clip it", () => {
  // Measured on the running app at 1440x900 dSF 6, by forcing this one property to `visible` and
  // differencing the screenshots: 33 device pixels changed. The box is rotated and rounded, so
  // clipping to its own padding box shaves the mark's corner and the italic glyph bearings — the
  // trailing "R" of MASTER sits 0.12px inside the content edge.
  const logo = logoOf(topBarCode);

  // The BOX must not clip. Its `display: flex, alignItems: center` line is where the clip lived.
  // Slice from the fill to the END of that same style object — searching for "}}>" from index 0
  // would find the OUTER wrapper div's, which closes before the fill even appears, and an empty
  // slice makes the negative assertion below pass without testing anything.
  const fillAt = logo.indexOf('background: "#ffffff"');
  assert.ok(fillAt > 0, "the stamp's fill declaration moved");
  const box = logo.slice(fillAt, logo.indexOf("}}>", fillAt));
  assert.ok(box.length > 40, "the stamp's style object could not be isolated");
  assert.ok(!/overflow/.test(box), "the stamp box clips the mark again");

  // The COLLAPSING SPAN must still clip — that is the one thing that legitimately needs it, and
  // removing it would let "esume Master" spill out of a zero max-width instead of collapsing.
  assert.match(logo, /maxWidth: textMaxW \+ "px",\s*\n\s*overflow: "hidden"/,
    "the collapsing span lost the clip that makes the collapse a collapse");
});

test("the app mark and the marketing mark are the same mark", () => {
  // StampLogo is the MARKETING rendering (NavBar + the landing hero) and ScrollDock carries a third.
  // All three are the same logo, so the fill and border must agree across them — the app copy
  // drifting away from the other two is exactly what W6 did, and a per-file assertion would not
  // have caught it. Quote styles differ (JSX attr conventions per file), the values must not.
  const logo  = logoOf(topBarCode);
  const stamp = stripComments(read("client/src/components/StampLogo.jsx"));
  const dock  = stripComments(read("client/src/components/ScrollDock.jsx"));

  for (const [name, src] of [["StampLogo", stamp], ["ScrollDock", dock]]) {
    assert.match(src, /background: ['"]#ffffff['"]/, `${name} lost the white fill`);
    assert.match(src, /border: ['"]2\.5px solid #0f0f0f['"]/, `${name} lost the stamp border`);
  }
  assert.match(logo, /background: "#ffffff"/);
  assert.match(logo, /border: "2\.5px solid #0f0f0f"/);
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
