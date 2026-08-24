# Third-party notices

Components of OSI OS incorporate third-party work. This file records what, from
where, and under which licence, as those licences require.

---

## Material Symbols — valve glyph

**Used in:** `web/react-gui/src/components/farming/valves/ValveGlyph.tsx`
(the `OUTLINE_PATH` and `FILLED_PATH` constants).

The valve outline and filled body paths derive from **Material Symbols** by
Google.

- Upstream project: `google/material-design-icons`
- Source icons:
  - `symbols/web/valve/materialsymbolsrounded/valve_24px.svg`
  - `symbols/web/valve/materialsymbolsrounded/valve_fill1_24px.svg`
- Upstream licence: **Apache License 2.0**

They reached this repository via the `OSI_OS_valve_icons_v2` design package,
which had already made these modifications upstream:

- assigned state colours;
- used the outlined glyph for the closed state and the filled glyph for open;
- added an original SVG water stream, moving internal bands and restrained
  droplets;
- added React integration, static exports and reduced-motion handling.

Further modifications made when integrating into OSI OS:

- replaced the package's fixed hex colours with OSI OS theme tokens, so the
  glyph follows the **application** theme rather than a light-ground palette
  (the package's `#1E3A8A` open colour is invisible on our dark surface — see
  osi-os#160 for the same bug class);
- retargeted the cyan water family per theme, because on dark the package's
  `#38BDF8` sits too close to our `--primary` to read as separate material;
- extended the package's three states (`open`/`closed`/`unknown`) to the five
  this application derives (`closed`/`pending`/`open`/`closing`/`failed`), and
  added the countdown ring and status badges, which the package does not carry;
- kept the package `viewBox` (`0 -960 960 1000`) verbatim so the donated paths
  are not re-scaled by hand.

The full Apache License 2.0 text accompanies the upstream project and the design
package (`LICENSES/Apache-2.0.txt` therein). Apache-2.0 §4 requires retention of
attribution notices; that is the purpose of this entry.

### Where the animation came from

The water stream, its moving highlight bands and the droplet motion are original
to the `OSI_OS_valve_icons_v2` package (not Material Symbols), reproduced here
with the class names renamed into this component's namespace and the animation
made conditional on a confirmed-open state.
