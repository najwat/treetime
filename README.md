# Seattle Street Trees

A small static web app for exploring Seattle's street trees. It uses plain HTML, CSS and JavaScript with no build step and no backend. You can filter by tree type and trunk diameter and see the matching trees on a map.

Data comes live from the SDOT Trees ArcGIS FeatureServer:

```
https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/SDOT_Trees_CDL/FeatureServer/0
```

Only in-service trees are shown (`CURRENT_STATUS = 'INSVC'`).

## Features

- **Tree type filter**: a searchable dropdown of common names, sorted by how many trees each has.
- **Diameter filter**: a two-handle range slider on trunk diameter (inches). The top stop means "this size or larger".
- **Map**: Leaflet with OpenStreetMap tiles. Each tree is a point sized by diameter. Tap or click a tree for a popup with its name, scientific name, diameter, height, location and other details.
- **Count**: the number of matching trees citywide and in the current map view.
- Works on phones: on narrow screens the filters stack above the map and can be collapsed.

## How it queries the data

Filtering is done by the ArcGIS REST API, so the browser never downloads the whole dataset:

| What | Query |
| --- | --- |
| Field names | `GET …/FeatureServer/0?f=json`, read once at startup |
| Tree-type list | `query` with `groupByFieldsForStatistics=<common name>` and a `count` statistic |
| Diameter range | `query` with a `max` statistic on the diameter field |
| Citywide count | `query` with `where=<filters>&returnCountOnly=true` |
| Trees on the map | `query` with `where=<filters>` plus the current map extent as an envelope, up to 2,000 points per view |

When more trees match in the current view than can be drawn at once, the app says so and asks you to zoom in.

### Field mapping

The app reads the layer's field list when it starts. It then picks the species and size fields from a list of expected names in `CONFIG.fields` at the top of `app.js`:

| Purpose | Expected field |
| --- | --- |
| Common name (used for the filter) | `COMMON_NAME` |
| Scientific name | `SCIENTIFIC_NAME` |
| Trunk diameter (used for the filter) | `DIAM` |
| Height | `TREEHEIGHT` |

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
index.html   page markup; loads Leaflet 1.9.4 from unpkg
style.css    layout and styles (light/dark, mobile)
app.js       config, ArcGIS queries, filters, map
.nojekyll    serve the files as-is on GitHub Pages
```

## Credits

- Tree data: City of Seattle, Seattle Department of Transportation (SDOT).
- Map tiles: © OpenStreetMap contributors. Please follow the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/). For heavy traffic, switch to a commercial tile provider.
