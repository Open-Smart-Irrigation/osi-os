# Try OSI OS

Explore irrigation zones, sensor readings, schedules and valve controls in the
OSI OS dashboard.

The compact **Try me!** phone invitation appears on the homepage and opens OSI OS
directly in the same tab. The persistent **Try OSI OS** link on the OSI System
page remains available if the invitation is dismissed. This optional page can
also host OSI OS in a responsive frame:

Add the static call-to-action with `[osi_simulator_cta]` in a WordPress content
block. Add **Try OSI OS** to the site's navigation menu with `/simulator/` as
the destination. The release plugin provides the shortcode styling from the
versioned local asset directory.

```html
<iframe
  src="https://opensmartirrigation.org/simulator/"
  title="OSI OS dashboard"
  loading="lazy"
  sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
  allow="geolocation 'none'; camera 'none'; microphone 'none'"
  style="display:block;width:100%;height:min(900px,100vh);border:0"
></iframe>
<p><a href="https://opensmartirrigation.org/simulator/">Open OSI OS</a></p>
```

Use a 900px frame on desktop and let it fill the viewport on small screens. Keep
the full-view link visible on mobile, where it gives the app the entire screen
and avoids nested scrolling. The app's static response policy is
scoped to `/simulator/`; do not add it to the WordPress page.

The local `demo/website/embed.html` fixture tests the outer frame and native
browser confirmations. It does not verify the live Elementor template. Leave the
interactive embed unpublished until that template has passed the same checks.
The older R1 modal invitation is superseded and must not be reinstalled.
