# Design reference: Seattle street trees app

`reference/prototype.html` is a working prototype. Match its look and behavior. Reuse its CSS tokens directly rather than re-deriving them.

## Layout
- Desktop: fixed 340px filter sidebar on the left, full-height map on the right.
- Phone (≤760px): title and tree count, then the map at ~58% of the viewport height, then the filters below it.
- Sidebar order: title and one-line scope, big tree count, Tree family chips, Trunk diameter (4 presets plus a two-thumb range slider), Species search and ranked list, data credit footer.

## Color
- Cool, slightly green neutrals (`--bg #eef1ec`, `--panel #f8faf6`, `--ink #1d2a22`). No pure grey and no pure white.
- One UI accent: moss green `--accent #2f6b46`. Use it for active states, slider fill, and focus rings only.
- Eight tree-family colors (`--f-maple`, `--f-cherry`, and so on) are used only for map dots, chip swatches, and species bars. Never use them for UI chrome.
- Full dark theme. Every color is a CSS variable, redefined under `prefers-color-scheme: dark` and under `[data-theme="dark"]`.

## Type
- Display: Bricolage Grotesque 700, for the title, the big count, and card headings.
- Body: IBM Plex Sans.
- Data: IBM Plex Mono, for counts, diameters, coordinates, and the scale bar. Use tabular numbers.
- Section labels: 11px uppercase with 0.08em letter-spacing, in the muted color.

## Map
- Dots are sized by trunk diameter and colored by family. Draw the largest trees first so small ones sit on top.
- Filtered-out trees stay visible as tiny faint dots, so the street grid and context never disappear.
- Controls: drag to pan, scroll or pinch to zoom, and +/−/reset buttons at top right. North arrow at top left. A metric scale bar at bottom left that updates with zoom.
- Hovering a dot shows a tooltip with the name and diameter. Clicking a dot opens a detail card at bottom right with the name, genus, diameter in inches and cm, family, coordinates, and an "Open in Google Maps" link.
- The real app should add street map tiles (Leaflet + OpenStreetMap or a muted basemap such as CARTO Positron/Dark Matter) that match the theme. Keep the dot styling.

## Interaction details
- Family chips toggle on and off. Clicking a chip while all are on isolates that family. "Show all" resets.
- Size presets: Young <6″, Medium 6–17″, Mature 18–35″, Giant 36″+. Clicking an active preset clears it.
- The species list shows the top 12 for the current filters, each with a count and a thin proportional bar in its family color. Clicking a species filters to it, and clicking it again clears it.
- The count reads "X of Y trees shown".
- The page opens in a useful state, with the largest tree selected.

## Copy
- Plain and specific. Name things the way a resident would ("Trunk diameter", "Tree family"). Avoid database field names.
