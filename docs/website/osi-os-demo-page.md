# Try OSI OS

Explore a working irrigation dashboard with a fictional farm. The browser
simulator includes sample soil readings and standard History, water balance,
sensors, zones, a valve, irrigation schedules and automatic controls. It uses
no hardware, account or sign-up. All changes stay in the browser session and
Reset restores the demonstration data.

The compact **Try me!** phone badge appears on the homepage and opens the
simulator directly in the same tab. The persistent **Try OSI OS** link on the
OSI System page remains available if the badge is dismissed. This optional page
can also host the simulator in a responsive frame:

```html
<iframe
  src="https://opensmartirrigation.org/simulator/"
  title="Try OSI OS with a fictional farm"
  loading="lazy"
  sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
  allow="geolocation 'none'; camera 'none'; microphone 'none'"
  style="display:block;width:100%;height:min(900px,100vh);border:0"
></iframe>
<p><a href="https://opensmartirrigation.org/simulator/">Open the full simulator</a></p>
```

Use a 900px frame on desktop and let it fill the viewport on small screens. Keep
the full-view link visible on mobile, where it gives the simulator the entire
screen and avoids nested scrolling. The simulator's static response policy is
scoped to `/simulator/`; do not add it to the WordPress page.

The local `demo/website/embed.html` fixture tests the outer frame and native
browser confirmations. It does not verify the live Elementor template. Leave the
interactive embed unpublished until that template has passed the same checks.
The older R1 modal invitation is superseded and must not be reinstalled.
