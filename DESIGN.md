# Design reference: TreeTime

`reference/prototype.html` is a working prototype. Match its look and behavior. Reuse its CSS tokens directly rather than re-deriving them.

## Layout
- Desktop: fixed 340px filter sidebar on the left, full-height map on the right.
- Phone (≤760px): full-screen map; the sidebar is a draggable bottom sheet, collapsed to the header, tab bar and search field.
- Sidebar: header (TreeTime, theme cycle button, About dialog with the data note), then Explore / Saved tabs. Explore: species search (typeahead; top 5 in view when empty), family chips, size presets with a Custom slider. Saved: saved trees, "Show only these on map". Explore fits without scrolling at 800px tall.

## Color
- Cool, slightly green neutrals (`--bg #eef1ec`, `--panel #f8faf6`, `--ink #1d2a22`). No pure grey and no pure white.
- One UI accent: moss green `--accent #2f6b46`. Use it for active states, slider fill, and focus rings only.
- Ten tree-family colors (`--f-maple`, `--f-cherry`, … `--f-flowering`, `--f-shade`, `--f-other`) are used only for map dots, chip swatches, and species bars. Never use them for UI chrome.
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
- Seattle only: open on the whole-city fit; no zooming out past it; panning stops ~10% past the city. Outside the city, a ground-colored mask (75% light / 80% dark) sits above the basemap and below the trees and labels, with a 1px muted city outline at 50% opacity.
- Basemap: MapLibre GL JS with OpenFreeMap vector tiles (Positron for light, Dark for dark), recolored to the tokens so it recedes behind the trees. Trees are a circle layer above roads and buildings and below street labels, with a 1px ground-colored halo.

## Interaction details
- Family chips toggle on and off. Clicking a chip while all are on isolates that family. "Show all" resets.
- Size presets: Young <6″, Medium 6–17″, Mature 18–35″, Large 36–49″, Giant 50″+. Clicking an active preset clears it.
- The species list shows the top 12 for the current filters, each with a count and a thin proportional bar in its family color. Clicking a species filters to it, and clicking it again clears it.
- No count box. When a filter is active, a pill centered at the top of the map describes the result in plain words ("1,204 maples · 18–35″ · Clear filters"). The "Zoom in to see individual trees" message uses the same spot, so they never overlap.
- The page opens in a useful state, with the largest tree selected.

## Copy
- Plain and specific. Name things the way a resident would ("Trunk diameter", "Tree family"). Avoid database field names.
