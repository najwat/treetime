# Seattle Street Trees

A small static web app for exploring Seattle's street trees. It uses plain HTML, CSS and JavaScript with no build step and no backend. You can filter by tree family, trunk diameter and species and see the matching trees on a map. The look and behavior follow [`DESIGN.md`](DESIGN.md) and [`reference/prototype.html`](reference/prototype.html).

Data comes live from the SDOT Trees ArcGIS FeatureServer:

```
https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/SDOT_Trees_CDL/FeatureServer/0
```

Only in-service trees are shown (`CURRENT_STATUS = 'INSVC'`).

## Features

- **Tree family chips** with citywide counts (Maples, Cherries & plums, Pears & apples, Ashes, Birches, Oaks, Conifers, Everything else). Clicking a chip while all are on shows only that family; after that, clicks add or remove families. **Show all** resets. A tree's family comes from the genus in its scientific name.
- **Trunk diameter**: Young (<6″), Medium (6–17″), Mature (18–35″) and Giant (36″+) presets, plus a two-thumb slider from 0 to 72+ inches. Clicking an active preset clears it.
- **Species**: a search box and a ranked list of the top 12 species for the current filters, each with a count and a bar in its family color. Click a species to filter to it, and click it again to clear it.
- **Count**: "X of Y trees match", where Y is every in-service tree in the city.
- **Map**: Leaflet on a muted CARTO basemap (Positron in light mode, Dark Matter in dark mode). Dots are colored by family and sized by trunk diameter (about 2–8px, smaller when zoomed out), and the largest trees are drawn first. Trees load for the visible area as you pan and zoom. If more than 3,000 trees match in view, the map says "Zoom in to see individual trees" instead of drawing a partial set.
- **Tree details**: hover a dot for its name and diameter; click it for a card with the name, scientific name, trunk diameter in inches and cm, family, address, planting date, coordinates and a Google Maps link.
- Opens on the largest recorded tree, already selected.
- Light and dark themes follow the system setting, or set `data-theme="light"` or `"dark"` on `<html>`.
- On screens up to 760px wide: the title and count come first, then the map at 58% of the screen height, then the filters.

### Diameters over 80 inches

Some records have trunk diameters that can't be real, such as 999. The app treats any value over 80″, or a value of 0, as **not recorded**:

- The size presets and the slider leave these trees out.
- They are skipped when finding the largest tree.
- The detail card shows "Not recorded".

With no size filter set, they still appear on the map and in the counts.

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

The `.nojekyll` file tells Pages to serve the files as they are, without running Jekyll. All paths are relative, so the app works under the `/<repo-name>/` subpath.

## Files

```
index.html               page markup; loads Leaflet 1.9.4 from unpkg and fonts from Google Fonts
style.css                design tokens (light and dark), layout, components
app.js                   config, ArcGIS queries, filters, map
DESIGN.md                design brief
reference/prototype.html working design prototype (sample data, no basemap)
.nojekyll                serve the files as-is on GitHub Pages
```

## Credits

- Tree data: City of Seattle, Seattle Department of Transportation (SDOT).
- Basemap: © OpenStreetMap contributors, © CARTO. Tiles are requested with the CARTO basemaps API key in `CONFIG.cartoKey` (`app.js`). The key is visible to every visitor, so restrict it to your site's domain in the CARTO dashboard.
- Fonts: Bricolage Grotesque, IBM Plex Sans and IBM Plex Mono, from Google Fonts.
