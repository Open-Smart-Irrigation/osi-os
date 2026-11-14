# Public simulator release and rollback

The direct simulator is served from `https://opensmartirrigation.org/simulator/`.
Its static files are isolated under `/simulator/`; the homepage invitation uses
local assets under `/wp-content/uploads/osi-os-demo/`. Keep normal WordPress
headers and scripts on the website. Never apply the simulator Content Security
Policy to WordPress responses. This compact homepage badge supersedes the
earlier R1 modal package, which is historical and must not be installed as the
current design.

The public build exposes water balance, irrigation schedules, valves,
environment and sensor readings, local account and support settings, and
standard zone History. The Dashboard has no zone History shortcut; direct
native History routes remain available. Eight supported device types can be
added through the native forms. UC512 registration is refused with an explicit
message until the GUI has an inspectable UC512 card.
Prediction advisory, Data/analysis, Network, Gateway hub, and Field Journal are
excluded: their public module defaults are off, their Settings controls are
absent, and `/analysis`, `/network`, `/journal`, and
`/history/gateways/:gatewayEui/cards/:cardId` return to Dashboard. The native
zone History route continues to open standard History when the gateway Data
module flag is false. Public Environment has four tabs (Water, Soil,
Weather, Agronomy) without header badges. Seeded S2120 cards expose dated rain,
pressure, light, and UV readings. Production and FAO routes keep their existing
behavior.

## Build and record the reviewed package

From `web/react-gui`, run `npm run demo:build:public` and
`npm run demo:build:website` on the reviewed source revision. The complete
contents of `public-demo-build/` are the `/simulator/` artifact. The website
packager copies eight checked inputs into `website-demo-build/`: the invitation
script, style, screenshot and HTML, the CTA HTML and style, plus `preview.html`
and `embed.html`. Upload the invitation's four assets and `cta.css` to the
versioned WordPress asset directory. Keep the CTA HTML, preview and embed as
review fixtures; the shortcode emits the reviewed CTA markup.

Name the release archive with the reviewed source commit, for example
`osi-public-simulator-v2-<commit>.tar.gz`. Record that commit and SHA-256 for
the archive and every file in it before upload. Keep the manifest with the
release record. Do not rebuild after hashing; a source or build change requires
a new review, archive, and manifest.

Before uploading or editing WordPress, inspect the existing simulator path,
invitation asset directory, active site-specific MU plugins, and the
`/osi-system/` page content. Back up the complete existing `/simulator/` tree,
all files under `/wp-content/uploads/osi-os-demo/` if present, the exact
site-specific plugin file that contains the persistent GitHub-button
integration, and an export or source copy of the current `/osi-system/` content
with its existing links. Save the backup and file list outside the served web
root in a restricted, dated location. Record original paths and SHA-256
checksums; verify the archive and checksums before changing anything. Keep
WordPress configuration backups private because they may contain unrelated
credentials.

Before enabling the invitation, confirm the host can apply the supplied headers
only under `/simulator/` and can purge or invalidate affected WordPress and CDN
page caches. If either capability is unavailable, leave the invitation
disabled and report the missing hosting capability.

## Add the simulator entry points

Add `[osi_simulator_cta]` to the homepage content or a prominent landing-page
section. The plugin prints the static CTA and loads its versioned `cta.css`.
Add a **Try OSI OS** item to the WordPress navigation menu through the menu
editor, with `/simulator/` as its destination. The repository does not contain
the theme header source, so keep this as an editor action. Retain the existing
homepage badge as a second entry point.

## Install the homepage badge

After the reviewed package is uploaded, create a new, release-specific directory
such as `/wp-content/uploads/osi-os-demo/v2-<reviewed-source-commit>/`. Copy
`invitation.js`, `invitation.css`, `invitation.html`, `osi-os-preview.png` and
`cta.css` from `website-demo-build/` into that directory. Do not overwrite a
prior release's assets. The invitation script resolves its HTML and screenshot
relative to its own URL and links to `/simulator/` on the current site origin.

Review `docs/website/osi-os-demo-plugin.php`. Replace only
`REPLACE_WITH_REVIEWED_SOURCE_COMMIT` with the frozen 40-character reviewed source
commit in lowercase hexadecimal; retain the `v2-` prefix. The rendered value
must be `v2-<commit>`. Keep the rendered plugin bytes with the release
manifest. The source placeholder fails closed until it matches `v2-` followed
by exactly 40 lowercase hexadecimal characters. Lint and hash those exact
rendered bytes before installation. Install the rendered file as
`wp-content/mu-plugins/osi-public-simulator.php`. It enqueues the CSS and script
only on `is_front_page()`, keeps normal WordPress headers and unrelated plugins
alone, and emits a deferred script tag. The script loads the HTML and screenshot
as the other two local static assets.

Removing or renaming only `wp-content/mu-plugins/osi-public-simulator.php` is
the independent badge disable switch; `/simulator/` and the persistent link
remain available. After inspecting and backing up the exact source of the
existing site-specific GitHub-button integration, add a persistent **Try OSI
OS** link near its View on GitHub and Releases & Downloads links on
`/osi-system/`:

```html
<a href="/simulator/">Try OSI OS</a>
```

Purge affected WordPress page caches and CDN entries after enabling, disabling,
updating, or rolling back the MU plugin; cached HTML can otherwise keep loading
an old invitation script. The versioned asset directory prevents cached old
assets from being reused by a new release. Keep earlier release directories
until the rollback window closes. The persistent link can be removed separately
if the simulator itself is rolled back.

## Verify before enabling

Run `CI=1 npm run demo:test:public -- --workers=1` on all three configured
projects with zero skipped tests. Confirm Settings has no experimental
module controls or Journal detail section, the Dashboard has no experimental
Data/Network/Gateway/Journal entries, and direct experimental routes return to
Dashboard. Navigate directly to `#/history/zones/1` and verify the standard soil
History card and its offered CSV export. Confirm support submission remains in
Settings. The retired empty browser scaffolds are indexed in
`demo/public-coverage-map.json`; the map points to substantive model tests where
they exist and explicitly does not claim browser coverage for each inventory
row. The public browser suite runs with zero skipped tests.

Confirm uploaded simulator files match the reviewed package manifest and that
`/simulator/` returns the expected HTML, scripts and styles with the scoped
simulator headers. HTML under `/simulator/` must be `Cache-Control: no-store`;
fingerprinted `/simulator/assets/` responses must be
`public, max-age=31536000, immutable`. The simulator CSP must include
`frame-src 'self' blob:`. Firefox requires the `blob:` frame source when the
simulator downloads a local CSV through an owned Blob URL. The CSP permits Blob
URLs to be framed generally; the in-app download guard still limits its
download path to an owned object URL with a nonempty filename. Retain
`connect-src 'none'`, `frame-ancestors` for the approved site origin(s),
`form-action 'none'`, and `worker-src 'none'`. Also check
`Permissions-Policy: geolocation=(), camera=(), microphone=()`,
`X-Content-Type-Options: nosniff`, and
`Referrer-Policy: strict-origin-when-cross-origin`. Confirm WordPress pages do
not receive simulator CSP or cache rules.

After installing the MU plugin and updating the `/osi-system/` link, purge the
affected WordPress full-page cache and CDN entries. Open the homepage,
`/osi-system/`, another inner page, and admin in fresh browser sessions. Confirm
only the homepage enqueues the selected release assets, all four invitation
assets return 200 there, and no stale page cache shows an older plugin or asset
path. For disable or rollback, remove or rename the MU plugin and purge those
same caches. Verify a fresh homepage response no longer enqueues the badge while
`/simulator/` and the persistent link remain usable.

In fresh desktop and mobile homepage sessions, check that the phone link sits
below the actual menu button and the open navigation overlay covers it. The
invitation is a single phone link with no close control. Escape hides the
invitation. Activate the link and use Back; the invitation should remain hidden
for that tab session. Normal page navigation and scroll stay usable. The badge
appears only on the homepage. The mobile simulator remains
edge-to-edge. Local browser fixtures do not verify the live theme, cache, or
hosting headers.

## Rollback

1. Remove or rename `wp-content/mu-plugins/osi-public-simulator.php` to disable
   the badge. Restore the backed-up GitHub-button integration or `/osi-system/`
   content if either was changed.
2. Purge affected WordPress page and CDN caches. Verify a fresh homepage
   response no longer enqueues the badge.
3. Restore the complete previous `/simulator/` tree from its verified backup
   and compare checksums with the saved manifest.
4. Verify the restored simulator, existing page links, and normal WordPress
   pages in fresh sessions. Keep invitation assets available until cached pages
   have expired or been purged.

Keep the previous simulator package and verified invitation manifest until the
live smoke check is complete. Record the source commit, uploaded file checksums,
hosting header results, and rollback package in the release record.
