# Compact website simulator invitation

The user's latest website instructions supersede the large modal invitation in
the first-release plan. The existing website remains available while a small
phone invitation floats below the menu at the upper right of the homepage.

The invitation shows the real OSI OS screenshot inside a white smartphone frame,
with the exact text **Try me!** below. Its visible phone-and-caption block is
10% of the current viewport height. It links directly to `/simulator/` on the
current origin in the same tab. A separate close cross dismisses it for the tab
session. Escape also dismisses it. It does not lock scrolling, make the website
inert, trap focus, move initial focus, dim the page, or obstruct the menu.

Use the website's existing WASAG approach: an independent site-specific
WordPress hook and a fixed, scoped invitation. Preserve the WASAG ribbon.
The actual menu button is `#osiUBurger`, within `#osiUHeader`; it is visible up
to 880px. Place the badge below the visible button with a gap. On desktop, where
the button is hidden, anchor below the header at the right viewport edge.
Reposition after resize, orientation changes and header size changes. Keep the
badge below the navigation overlay in the stacking order so an open menu remains
usable. The badge appears only on the main homepage; the direct simulator and
persistent OSI System link remain available separately.

The phone preview retains a white frame on both website viewport sizes. After
entry, desktop uses the matching white smartphone frame around the functional
simulator. Mobile keeps the accepted direct, frameless OSI OS interface and its
existing simulation controls. The current native app and local-only transport
contract remain unchanged.

Retain an accessible simulator link, real screenshot alt text, visible keyboard
focus, and at least 44px interactive hit areas. One anchor wraps the phone and
caption; its hit area is at least 44px wide and high. A sibling close button has
a separate 44px hit area, placed beside the anchor with an 8px gap. The phone and
caption remain 10dvh even when the hit areas are taller. The outer container has
no pointer events; only the two controls receive them. These targets must not
intersect the menu or cover unrelated page controls. No app scripts or data are
loaded before entry. Retain
idempotence, tab-session dismissal, unavailable-storage fallback, normal Back
navigation, reduced motion, and narrow/landscape support. The old modal focus
trap and page-lock tests must be replaced by positive normal-page usability
tests; this is a changed requirement, not a waived failure.

SSH access to the actual website works. WordPress uses Astra, a custom unified
header, and WP Super Cache. WASAG is injected through `wp_footer` in an existing
site-specific plugin; its fixed top-left ribbon has scoped styles. A separate
simulator plugin must not alter that ribbon, global headers, unrelated plugins,
the theme, or existing page content. Install it as the independent
`wp-content/mu-plugins/osi-public-simulator.php`; removing or renaming that file
disables the invitation. The source placeholder must fail closed until replaced
with a valid reviewed release ID. Lint and hash the exact rendered PHP before
activation and include it in the deployment manifest. Credentials and private hosting details
must remain outside the repository and public evidence.

Publication is already authorized. The exact verified simulator goes live first
with headers scoped to `/simulator/`; only then enable the homepage invitation,
purge affected caches, verify actual navigation and publish the GitHub link.
Preserve verified private backups and independently reversible invitation and
simulator deployments. The previous invitation ZIP is historical and must not
be installed as the latest design.
