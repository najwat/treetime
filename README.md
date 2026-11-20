# TreeTime

TreeTime is a small static web app for exploring Seattle's publicly inventoried trees. It uses plain HTML, CSS and JavaScript modules with no build step and no backend. You can filter by source, tree family, trunk diameter and species and see the matching trees on a map. The look and behavior follow [`DESIGN.md`](DESIGN.md).

Data comes live from two City of Seattle ArcGIS services:

| Source | Layer | Shown |
| --- | --- | --- |
| Street trees (SDOT) | `SDOT_Trees_CDL` | `CURRENT_STATUS = 'INSVC'` |
| Park trees (Seattle Parks and Recreation) | `SPR_Tree_View` | `STATUS = 'Existing'` |

How the sources were chosen, and which were turned down, is in [`docs/AUDIT.md`](docs/AUDIT.md).

## Features

- **Header**: TreeTime, a theme button that cycles System → Light → Dark (its tooltip says which), and **About**, which opens a short note about the data.
- **Tabs**: **Explore** and **Saved** (with a count). The last tab you used is remembered.
- **Explore**
  - **Species search** is the species filter. Typing suggests matching species, with counts for the current filters. Enter or a click filters to one, and × clears it. When the box is empty and focused, it lists the five most common species in the current map view.
  - **Tree family chips** with citywide counts: Maples, Cherries & plums, Pears & apples, Oaks, Ashes, Birches, Conifers and Everything else. Clicking a chip while all are on shows only that family; after that, clicks add or remove families. **Show all** resets. A tree's family comes from the genus, the first word of its scientific name (`FAMILIES` in `js/tree.js`); any other genus is "Everything else".
  - **Source chips**: Street trees and Park trees, with counts. At least one stays on.
  - **Trunk diameter**: Young (<6″), Medium (6–17″), Mature (18–35″), Large (36–49″) and Giant (50″+). **Custom** reveals a two-thumb slider from 0 to 72+ inches. Clicking an active preset clears it.
  - At 1280×800 the whole tab fits without scrolling.
- **Saved**: trees you saved with **☆ Save** on a tree's card, each with its species, address and trunk size. Click a row to fly to the tree and open its card; × removes it. **Show only these on map** limits the map to your saved trees, and the family, size and species filters still apply. Saved trees also show as ★ on the map.
  - **Nicknames**: the pencil beside **Save** on a tree's card opens an inline field (up to 30 characters; emoji count as one). Enter or clicking away saves it, and Escape cancels. Naming a tree also saves it, and clearing the name keeps the tree saved. A named tree's card shows the nickname as the heading, with the species and diameter muted below. The Saved list uses the same order, and from zoom 17 the nickname appears as a small label under the tree on the map (12px body font, with a halo in the map's ground color).
  - The card shows **Saved since Nov 2026**, the month the tree was first saved.
  - On load, saved trees are checked against the city's in-service inventory. A tree that's no longer there stays in the list, marked "No longer in the city’s inventory", with its last known details, and can still be removed.
  - Saved trees are kept in this browser's `localStorage` (key `treetime.saved.v2`), so they don't sync between devices. Each record is `{ id, tree, savedAt, since, name, gone }`, where `id` is the tree's stable id (`sdot:TRE-73801`, `spr:23759`) and `tree` is a copy of its details. Saves from earlier versions (keys `favoriteTrees` and `treetimeCrushes`) are migrated on load and the old keys are left in place (`js/saved.js`).
- **Filter pill**: when any filter is on, a pill at the top of the map sums up the result in plain words, such as "319 maples · 18–35″ · Clear filters" or "3 saved trees · Clear". The "Zoom in to see individual trees" message uses the same spot.
- **Map**: [MapLibre GL JS](https://maplibre.org) with [OpenFreeMap](https://openfreemap.org) vector tiles. The app loads OpenFreeMap's Positron style (light) or Dark style (dark) and recolors it in `themeStyle()` (`js/app.js`) so the basemap recedes behind the trees. The colours are the `--map-*` tokens in `style.css`:
  - Dark: ground `#0f1411`, minor roads `#1a221d`, major roads `#243029` with no casings, buildings `#141a16`, parks `#122019`, water `#0d1517`, labels `#7d8a81` with a ground-colored halo, street names from zoom 15.
  - Light: ground `#f4f6f1`, white roads with `#e2e7de` casings, buildings `#ebefe8`, parks `#e5eee1`, water `#dce7ea`, labels `#8a958d` with a white halo.
  - Both: buildings only from zoom 16, footpaths and sidewalks thin and close to the ground color, road shields hidden, other landuse hidden. All label layers are moved to the top of the style, so no road, path or building can be drawn over the trees.
  - Trees are a MapLibre circle layer above roads and buildings but below the first label layer, so street names stay readable. Dots are colored by family and sized by trunk diameter (about 2–8px, smaller when zoomed out), with a 1px halo in the ground color, and the largest trees are drawn first. From zoom 13.5 every tree in view is loaded and shown. Zoomed out further, dots show when 3,000 or fewer trees match the filters; otherwise the map asks you to zoom in.
- **Tree details**: hover a dot for its name and diameter; click it for a card with the name, scientific name, trunk diameter in inches and cm, height where recorded, family, address or park, planting date, heritage status, source, coordinates and a Google Maps link.
- **Seattle only**: the map opens fitted to the whole city, with the largest recorded tree's card open on wider screens (on phones it would cover half the city). You can't zoom out past that view, and panning stops about 10% past the city's edge at every zoom (a MapLibre transform constraint in `constrainView()`). Everything outside the city sits under a mask in the ground color (75% light, 80% dark) with the city cut out, and a 1px muted outline traces the edge. **Reset view** (⤢) returns to the whole-city fit. Tree requests are clipped to the city's bounding box.
- **Phones (≤760px)**: a full-screen map with the sidebar in a draggable bottom sheet. Collapsed, it shows the header, the tab bar and the search field; drag the handle up or tap it to expand. Focusing the search expands it, and opening a saved tree collapses it.

### Data quality

Each source's adapter cleans records as they arrive (`js/tree.js`), so the rest of the app never sees a bad value:

| In the data | Treated as |
| --- | --- |
| Trunk diameter over 80″, or 0 | not recorded: left out of size filters, shown as "Not recorded" |
| Height over 300 ft, or 0 | not recorded |
| Planting date in the future or before 1850 | no date |
| Planting date of 1 January | the year only |
| Names such as "Unknown" or "Vacant site" | no name ("Unknown species") |
| No usable location or id | the record is dropped |

### One tree, two inventories

Where a park meets a street the same tree can be in both inventories. Two records are treated as one tree when they come from different sources, share a genus, and are within 3 m (1 m if a genus is missing). The more detailed record is shown, and the card names both sources. Ids never change because of this, so saved trees are unaffected (`js/dedupe.js`).

### City boundary

`data/seattle-boundary.geojson` (about 22 KB) is loaded from the repo, not from the city at runtime. It is the City of Seattle's `jurisdiction` layer (feature `JURISDICTION = 'Seattle'`, [service](https://services.arcgis.com/ZOyb2t4B0UYuYNYH/ArcGIS/rest/services/jurisdiction/FeatureServer/3)): the city's land area along the shoreline, whose north and south edges follow the official Seattle City Limits lines. The portal's "Seattle City Limits" layer itself contains only those north and south lines, not a closed shape. The file was simplified with mapshaper:

```bash
mapshaper jurisdiction.geojson -clean -simplify 3% keep-shapes -filter-islands min-area=20000m2 -filter-fields -o precision=0.00001 format=geojson out.geojson
```

## How it loads the data

Each source is an adapter (`js/sources/`) that turns its service's records into TreeTime's tree format. Nothing outside that folder knows about ArcGIS.

| View | What happens |
| --- | --- |
| Page load | One grouped count per source gives the totals, family counts and species list. The result is stored for six hours and shown at once on the next visit. |
| Zoomed in (13.5 and closer) | Trees are loaded by map tile (zoom 14), one request per source per tile, up to 8,000 trees each. Tiles are kept in memory and in IndexedDB for six hours. Filters are applied in the browser, so changing a filter or panning back makes no request. |
| Zoomed out | The sources count the matching trees in view. If 3,000 or fewer match, they are loaded (paged by the layers' 2,000-record limit) and drawn. |
| Saved trees | Checked against the sources by id on load. |

## Tests

```bash
npm install
```

```bash
npm test
```

`npm test` runs the unit tests (`node --test`: the tree format and quality rules, the adapters, de-duplication, saved-tree migration, asset stamping) and the browser tests (Playwright, at desktop and phone sizes: map loading, filters, the tree card, saving, migration from earlier versions, keyboard access). The browser tests use no network: `tests/e2e/mock.js` stands in for the city's service using real records in `tests/fixtures/`. Node 22.5 or later is needed.

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

After changing anything in `js/` or `style.css`, run:

```bash
npm run stamp
```

It writes a content hash onto each file's URL in `index.html` (the stylesheet, the entry script, and an import map for every other module). Without it a browser can pair a fresh page with a cached old script, and the page breaks. A unit test fails if the stamps are out of date.

The `.nojekyll` file tells Pages to serve the files as they are, without running Jekyll. All paths are relative, so the app works under the `/<repo-name>/` subpath.

## Files

```
index.html               page markup; loads MapLibre GL JS 5.24.0 from unpkg and fonts from Google Fonts
style.css                palette, semantic tokens (light and dark), components, phone layout
js/app.js                the interface: map, filters, card, saved trees, basemap styling
js/tree.js               the tree format, families, data-quality rules, filter matching
js/sources/              one adapter per data source (sdot.js, spr.js) and shared ArcGIS helpers
js/data.js               loading across sources, tile and summary caching
js/dedupe.js             one tree in two inventories is shown once
js/saved.js              saved-tree storage and migration from earlier versions
js/cache.js              small IndexedDB store
scripts/stamp.mjs        versions asset URLs in index.html
tests/                   unit tests, browser tests, fixtures
docs/AUDIT.md            audit of the app and of other Seattle tree datasets
docs/ACCOUNTS-PROPOSAL.md  options for syncing saved trees (not built)
favicon.svg              site icon (switches to the light green in dark mode)
favicon-32.png           PNG icon for browsers without SVG icons
apple-touch-icon.png     180×180 home-screen icon
data/seattle-boundary.geojson  simplified Seattle boundary (see "City boundary")
DESIGN.md                design brief
reference/prototype.html working design prototype (sample data, no basemap)
.nojekyll                serve the files as-is on GitHub Pages
```

## Credits

- Tree data: City of Seattle, Seattle Department of Transportation (street trees) and Seattle Parks and Recreation, Urban Forestry (park trees). Provided by the City without warranty.
- Basemap: © OpenStreetMap contributors · OpenFreeMap. OpenFreeMap is free and needs no API key. Map rendering by MapLibre GL JS.
- Fonts: Bricolage Grotesque, IBM Plex Sans and IBM Plex Mono, from Google Fonts.
