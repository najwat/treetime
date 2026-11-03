# TreeTime

TreeTime is a small static web app for exploring Seattle's street trees. It uses plain HTML, CSS and JavaScript with no build step and no backend. You can filter by tree family, trunk diameter and species and see the matching trees on a map. The look and behavior follow [`DESIGN.md`](DESIGN.md) and [`reference/prototype.html`](reference/prototype.html).

Data comes live from the SDOT Trees ArcGIS FeatureServer:

```
https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/SDOT_Trees_CDL/FeatureServer/0
```

Only in-service trees are shown (`CURRENT_STATUS = 'INSVC'`).

## Features

- **Header**: TreeTime, a theme button that cycles System → Light → Dark (its tooltip says which), and **About**, which opens a short note about the data.
- **Tabs**: **Explore** and **Saved** (with a count). The last tab you used is remembered.
- **Explore**
  - **Species search** is the species filter. Typing suggests matching species, with counts for the current filters. Enter or a click filters to one, and × clears it. When the box is empty and focused, it lists the five most common species in the current map view.
  - **Tree family chips** with citywide counts: Maples, Cherries & plums, Pears & apples, Oaks, Ashes, Birches, Conifers and Everything else. Clicking a chip while all are on shows only that family; after that, clicks add or remove families. **Show all** resets. A tree's family comes from the genus, the first word of its scientific name (`FAMS` in `app.js`); any other genus is "Everything else".
  - **Trunk diameter**: Young (<6″), Medium (6–17″), Mature (18–35″), Large (36–49″) and Giant (50″+). **Custom** reveals a two-thumb slider from 0 to 72+ inches. Clicking an active preset clears it.
  - At 1280×800 the whole tab fits without scrolling.
- **Saved**: trees you saved with **☆ Save** on a tree's card, each with its species, address and trunk size. Click a row to fly to the tree and open its card; × removes it. **Show only these on map** limits the map to your saved trees, and the family, size and species filters still apply. Saved trees also show as ★ on the map.
  - Saved trees are kept in this browser's `localStorage` (key `favoriteTrees`), keyed by the city's tree ID (`UNITID`), with a copy of each tree's details, so they don't sync between devices.
- **Filter pill**: when any filter is on, a pill at the top of the map sums up the result in plain words, such as "319 maples · 18–35″ · Clear filters" or "3 saved trees · Clear". The "Zoom in to see individual trees" message uses the same spot.
- **Map**: [MapLibre GL JS](https://maplibre.org) with [OpenFreeMap](https://openfreemap.org) vector tiles. The app loads OpenFreeMap's Positron style (light) or Dark style (dark) and recolors it in `themeStyle()` (`app.js`) so the basemap recedes behind the trees. The palettes are in `BASEMAPS`:
  - Dark: ground `#0f1411`, minor roads `#1a221d`, major roads `#243029` with no casings, buildings `#141a16`, parks `#122019`, water `#0d1517`, labels `#7d8a81` with a ground-colored halo, street names from zoom 15.
  - Light: ground `#f4f6f1`, white roads with `#e2e7de` casings, buildings `#ebefe8`, parks `#e5eee1`, water `#dce7ea`, labels `#8a958d` with a white halo.
  - Both: buildings only from zoom 16, footpaths and sidewalks thin and close to the ground color, road shields hidden, other landuse hidden. All label layers are moved to the top of the style, so no road, path or building can be drawn over the trees.
  - Trees are a MapLibre circle layer above roads and buildings but below the first label layer, so street names stay readable. Dots are colored by family and sized by trunk diameter (about 2–8px, smaller when zoomed out), with a 1px halo in the ground color, and the largest trees are drawn first. Trees load for the visible area as you pan and zoom; above 3,000 matches in view, the map asks you to zoom in instead.
- **Tree details**: hover a dot for its name and diameter; click it for a card with the name, scientific name, trunk diameter in inches and cm, family, address, planting date, coordinates and a Google Maps link.
- **Seattle only**: the map opens fitted to the whole city, with the largest recorded tree's card open on wider screens (on phones it would cover half the city). You can't zoom out past that view, and panning stops about 10% past the city's edge at every zoom (a MapLibre transform constraint in `constrainView()`). Everything outside the city sits under a mask in the ground color (75% light, 80% dark) with the city cut out, and a 1px muted outline traces the edge. **Reset view** (⤢) returns to the whole-city fit. Tree requests are clipped to the city's bounding box.
- **Phones (≤760px)**: a full-screen map with the sidebar in a draggable bottom sheet. Collapsed, it shows the header, the tab bar and the search field; drag the handle up or tap it to expand. Focusing the search expands it, and opening a saved tree collapses it.

### Diameters over 80 inches

Some records have trunk diameters that can't be real, such as 999. The app treats any value over 80″, or a value of 0, as **not recorded**:

- The size presets and the slider leave these trees out.
- They are skipped when finding the largest tree.
- The detail card shows "Not recorded".

With no size filter set, they still appear on the map and in the counts.

### City boundary

`data/seattle-boundary.geojson` (about 22 KB) is loaded from the repo, not from the city at runtime. It is the City of Seattle's `jurisdiction` layer (feature `JURISDICTION = 'Seattle'`, [service](https://services.arcgis.com/ZOyb2t4B0UYuYNYH/ArcGIS/rest/services/jurisdiction/FeatureServer/3)): the city's land area along the shoreline, whose north and south edges follow the official Seattle City Limits lines. The portal's "Seattle City Limits" layer itself contains only those north and south lines, not a closed shape. The file was simplified with mapshaper:

```bash
mapshaper jurisdiction.geojson -clean -simplify 3% keep-shapes -filter-islands min-area=20000m2 -filter-fields -o precision=0.00001 format=geojson out.geojson
```

## How it queries the data

Filtering is done by the ArcGIS REST API, so the browser never downloads the whole dataset.

| Action | Requests |
| --- | --- |
| Page load | layer info; one grouped count by common and scientific name, which gives the total, family counts and the species list; the largest tree |
| Change family or size | count, species list, trees in view |
| Pick a species | count, trees in view |
| Pan or zoom (after a 300 ms pause) | count in view; then, if it's 3,000 or fewer, the trees in view (paged by the layer's record limit) |

### Field mapping

The app reads the layer's field list when it starts. It then picks the species and size fields from a list of expected names in `CONFIG.fields` at the top of `app.js`:

| Purpose | Field |
| --- | --- |
| Species | `COMMON_NAME` |
| Scientific name and family | `SCIENTIFIC_NAME` |
| Trunk diameter | `DIAM` |
| Address | `UNITDESC` |
| Planting date | `PLANTED_DATE` |
| Tree ID (favorites) | `UNITID` |

All of these were confirmed against the live layer.

If a name isn't found, the app looks for a field whose name or alias matches a pattern, such as `/diam|dbh/i`. Open the browser console to see which fields were picked (`[trees] resolved fields`). If the schema changes, edit `CONFIG.fields`.

## Run locally

Any static file server works. Opening `index.html` straight from disk can also work, but some browsers block `fetch` from `file://` pages.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Pick your branch (for example `main`) and the **/ (root)** folder, then click **Save**.
5. After a minute the site will be live at `https://<your-username>.github.io/<repo-name>/`.

When you change `app.js` or `style.css`, bump the `?v=` tag on their links in `index.html`. Otherwise a browser can pair a fresh page with a cached old script, and the page breaks.

The `.nojekyll` file tells Pages to serve the files as they are, without running Jekyll. All paths are relative, so the app works under the `/<repo-name>/` subpath.

## Files

```
index.html               page markup; loads MapLibre GL JS 5.24.0 from unpkg and fonts from Google Fonts
style.css                design tokens (light and dark), layout, components
app.js                   config, ArcGIS queries, filters, map, basemap styling
favicon.svg              site icon (switches to the light green in dark mode)
favicon-32.png           PNG icon for browsers without SVG icons
apple-touch-icon.png     180×180 home-screen icon
data/seattle-boundary.geojson  simplified Seattle boundary (see "City boundary")
DESIGN.md                design brief
reference/prototype.html working design prototype (sample data, no basemap)
.nojekyll                serve the files as-is on GitHub Pages
```

## Credits

- Tree data: City of Seattle, Seattle Department of Transportation (SDOT).
- Basemap: © OpenStreetMap contributors · OpenFreeMap. OpenFreeMap is free and needs no API key. Map rendering by MapLibre GL JS.
- Fonts: Bricolage Grotesque, IBM Plex Sans and IBM Plex Mono, from Google Fonts.
