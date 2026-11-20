# TreeTime audit

Written for the v2 work (see `TREETIME-V2-BRIEF.md`). Sections 1–3 describe the app as it was
before v2 (commit `7821c97`, the version live at the time). Section 4 is the data-source research.
Section 5 says what Phase 1 changed. The design critique for Phase 2 is section 6.

Screenshots of the app before v2 are in [`docs/audit/`](audit/), taken at 1280×800 and 390×844
in light and dark.

## 1. What was built, and how

A static site with no build step: `index.html`, `style.css` and one 1,200-line `app.js`.

| Area | Before v2 |
| --- | --- |
| Map | MapLibre GL JS 5.24.0 from unpkg (with integrity hashes), OpenFreeMap vector tiles (Positron in light, Dark in dark), recolored in code to a quiet palette. Labels are moved above the trees. A mask dims everything outside the city boundary (`data/seattle-boundary.geojson`, 26 KB). The view is constrained to the city. |
| Data | One source: SDOT's street tree layer (`SDOT_Trees_CDL`, ArcGIS FeatureServer), filtered to `CURRENT_STATUS = 'INSVC'`. All filtering was done by the server; every filter change or map move was a new request. |
| Filters | Species search (a combobox that is the species filter), eight family chips with counts, five size presets and a custom diameter range. |
| Tree card | Name, scientific name, trunk, family, address, planted date, a Google Maps link, Save, and a nickname. |
| Saved trees | A Saved tab with a count, a "Show only these on map" switch, star markers on the map, nickname labels at zoom 17+, and a "No longer in the city's inventory" marker. |
| Theme | System / Light / Dark, remembered. |
| Phone | Under 760px the sidebar becomes a bottom sheet with three positions. |
| Caching | `scripts/stamp.mjs` stamps a content hash on `style.css` and `app.js` so a fresh page never runs a stale script. |

### Data loading

- The layer returns at most **2,000 records** per normal request. The app asked for up to 3,000
  matching trees in the current view, in pages of 2,000, and only when a count said there were
  3,000 or fewer. Above that it drew nothing and showed "Zoom in to see individual trees".
- The result was that a normal neighbourhood view (zoom 14–15) with no filter showed **no trees**,
  and dots first appeared around zoom 16 ([z14](audit/before-1280-light-5-z14.png),
  [z15](audit/before-1280-light-4-z15.png), [z16](audit/before-1280-light-3-street-z16.png)).
- Each pan or zoom made a count request and then one or two data requests. Nothing was kept, so
  panning back made the same requests again. The server allows 30 seconds of browser caching.
- Family counts came from one grouped query on startup (about 1.5–3 s).

### Saved-tree storage

`localStorage`, key `favoriteTrees`: an array of
`{ key: 'id:TRE-73801', a: {…raw SDOT attributes…}, g: {x, y}, savedAt, since, name, gone }`.
Older versions wrote records keyed by `OBJECTID` (`oid:123`) or with no key, and one short-lived
version used the key `treetimeCrushes`. The app migrated those on load. A real capture from the
live version is in `tests/fixtures/saved-v1-from-app.json`.

## 2. Things the brief asked to check

| Question | Finding |
| --- | --- |
| Google Maps link | **Works.** `https://www.google.com/maps/search/?api=1&query=<lat>,<lng>`, opens in a new tab with `rel="noopener"`. It is only 20px tall on a phone. |
| The unlabeled "N" control | It is **not a control**. It is a decorative north arrow (`aria-hidden`), placed and styled like the buttons beside it, so it looks tappable and does nothing. The map cannot be rotated, so it carries no information. Recommended: remove it (done in Phase 2). |
| Diameter filter: range and units | Presets show their range with an inch mark ("18–35″"). The label reads "Any size" until one is chosen, then "18–35 in". The slider is hidden behind "Custom" and has no tick labels, so its 0–72 range is only visible by dragging. |
| Loading state | A "Loading trees…" pill after 400 ms ([light](audit/before-390-light-0-loading.png), [dark](audit/before-390-dark-0-loading.png)). The family chips show no counts until the first query returns, with nothing to say they are coming. |
| Empty state | "No matching trees in this area · Clear filters" ([screenshot](audit/before-1280-light-6-empty-filter.png)). Clear, and it offers the way out. |
| Does Favorites show a count | **Yes**, the Saved tab shows the number saved. |
| Dot density zoomed out | At the city view there are no dots at all unless a filter leaves 3,000 or fewer ([giant trees](audit/before-1280-light-7-city-giant.png)). When dots do show at city scale they overlap into blobs ([example](audit/before-1280-light-8-city-large-dense.png)). At zoom 15 they form a dense halo. |
| Dark-mode text size and weight | No text is under 12px in either theme. In dark, small text is weight 500 and the muted colour is `#b3c0b7` on `#101a14` (about 9:1). Readable. Monospace values on the card are a little faint at 13px. |

## 3. Bugs and rough edges

Ranked by how much they hurt.

1. **A saved tree's card closed itself.** Opening a saved tree from the list flew to it, then the
   card vanished about a second later. Saved records kept the `OBJECTID` from the day they were
   saved; the city reissues those, so the fresh data did not "contain" the selected tree and the
   card was dismissed. *Fixed in Phase 1* (trees are matched by their stable id).
2. **No trees at neighbourhood zoom.** See "Data loading". *Fixed in Phase 1.*
3. **Every pan re-fetched.** *Fixed in Phase 1* (tiles are cached).
4. **Tap targets under 44px on a phone.** Theme button 34, About 30 tall, tabs 39, search 39, family
   chips 31, "Show all" and "Custom" 17, zoom buttons 34, card close 28, pencil 30, Save 27, Google
   Maps link 20. *Phase 2.*
5. **A click could open the wrong tree.** Dots were identified by their position in a list that
   could change while the previous dots were still on screen. Found by the new tests. *Fixed in
   Phase 1.*
6. **"Everything else" is 39% of the trees** (84,311 of 215,781 street trees). The eight families
   are the common ones, but the catch-all is the biggest chip. Not changed; noted for a later run.
7. **Out-of-range diameters.** 33 street trees over 80″ (up to 555″) were already treated as "not
   recorded". Future planting dates (one tree "planted" in 2027) and 702 trees named "Unknown" were
   shown as they came. *Fixed in Phase 1.*
8. **The sheet's middle position hides most of the map** on a phone
   ([screenshot](audit/before-390-light-2-sheet-explore.png)); the card and the sheet compete for the
   bottom of the screen ([screenshot](audit/before-390-light-4-card-street.png)). *Phase 2.*
9. **One file.** `app.js` held data access, quality rules, storage, map and UI together, with no
   tests. *Fixed in Phase 1.*

Things that work well and were left alone: the basemap and boundary treatment, family colours,
the pill that describes the active filters in words, the combobox, theme switching, and the
nickname flow.

**Already built that the brief lists for the next run:** nicknames, "Saved since", and the marker
for trees that left the inventory. They were kept working and carried through the migration, and
not extended.

## 4. Other Seattle tree data

The bar for adding a source: individual trees with species and an accurate location, a credible
publisher, maintained, licensed for reuse, and reachable through an official API. Checked
November 2026 against the live services.

| Dataset | Publisher | Coverage | Trees | Fields | Currency | License / attribution | Access | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **SDOT Trees** (`SDOT_Trees_CDL`) | City of Seattle, Seattle Department of Transportation | Street trees citywide, plus some trees on other public land by ownership | 215,781 in service | id, common and scientific name, diameter, height (mostly empty), planted date, address, ownership, heritage flag | Refreshed daily | Seattle GIS Open Data, provided without warranty; credit the City of Seattle | ArcGIS FeatureServer, CORS open | **In use** |
| **SPR Tree View** (`SPR_Tree_View`) | Seattle Parks and Recreation, Urban Forestry | Individually inventoried trees in developed parks | 21,545 existing | id, common name, species, diameter, height, park name, status | Refreshed weekly | Same open-data terms; credit Seattle Parks and Recreation | ArcGIS FeatureServer, CORS open | **Added** |
| Combined Tree Point | City of Seattle | SDOT and SPR merged | about 237,000 | fewer fields, **no status field** (removed trees cannot be excluded) | Weekly | Open data | FeatureServer | Rejected: loses the status and source of each record |
| UW campus trees (PublicData layer 37) | University of Washington, Facilities | Seattle campus | 8,936 | tree number, species, common name, diameter, height | Edited 14 Nov 2026 | **"Educational and research purposes only… all other uses expressly prohibited"** | ArcGIS MapServer | **Does not clear the bar without permission.** Good data; worth asking UW (see open questions) |
| UW Botanic Gardens / Arboretum | UWBG | Washington Park Arboretum collections | — | — | — | — | Interactive map only, no public bulk service found | Rejected: no official bulk access |
| Trees for Neighborhoods plantings | Seattle Public Utilities | Trees given to residents | 14,467 | planting address, common name; no scientific name or size | Last updated 2024 | Open data | FeatureServer | Rejected: 10,586 are in private yards with home addresses, and nobody updates whether they are alive |
| Heritage trees | City of Seattle / Plant Amnesty | Designated heritage trees | 289 flagged within SDOT | flag on the SDOT record | With SDOT | With SDOT | With SDOT | Not a separate source; **shown on the card** as "City Heritage Tree" |
| King County tree canopy 2021 | King County | Countywide | millions of points | LiDAR tree tops: height only, **no species** | 2021 | Open | FeatureServer | Rejected: not an inventory |
| Green Seattle Partnership monitoring | SPR / GSP | Forested parkland | plots | plot summaries, not trees | Varies | Open | FeatureServer | Rejected: not individual trees |
| Seattle Center, Seattle Public Schools, Port of Seattle, Seattle City Light, state (WSDOT, DNR) | — | — | — | — | — | — | No separate public tree inventory found | Nothing to add; some of these trees are already in SDOT's layer by ownership |
| Seattle University, Seattle Pacific University | — | Campus | — | — | — | — | PDF tree walks only | Rejected: no API |
| iNaturalist | Community | Wherever people look | 91,684 research-grade plant observations in the Seattle area | species, photo, approximate location | Live | CC licences per observation | Official API | **Community source, not for the main map.** A candidate for an optional layer later |
| OpenStreetMap `natural=tree` | Community | Patchy | not verified (the Overpass API did not answer from here) | often no species | Live | ODbL | Overpass API | Community source, not for the main map; much of Seattle's OSM tree data was imported from SDOT anyway |

**Result:** one source cleared the bar and was added (Seattle Parks). The brief allowed up to
three; nothing else qualifies today.

### Overlap between the two sources

The two inventories share real trees where a park meets a street. In Queen Anne Boulevard, 107 of
4,936 trees in one view are in both. TreeTime treats two records as one tree when they come from
different sources, are the same genus, and are within 3 m (1 m if either has no genus). It shows
the more detailed record, keeps both ids, and says so on the card ("Street tree (SDOT); also in
the park tree inventory"). Ids never change because of this, so a tree saved before the match
was found stays saved.

Zoomed out, counts come from the sources separately, so the total can be a few higher than the
number of dots (1,399 giant trees counted, 1,392 shown).

## 5. What Phase 1 changed

- **One tree format** (`js/tree.js`): `id` (`sdot:TRE-73801`, `spr:23759`), `source`, `commonName`,
  `scientificName`, `genus`, `family`, `diameterIn`, `heightFt`, `lat`, `lng`, `planted`, `place`.
  Sources are adapters in `js/sources/`; nothing else knows about ArcGIS.
- **Data quality, in the adapter:** diameter over 80″ or 0 is not recorded; height over 300 ft is
  not recorded; planting dates in the future or before 1850 are dropped; 1 January dates are shown
  as a year; placeholder names ("Unknown", "Vacant site") become no name. The card says
  "Not recorded" or leaves the row out.
- **Saved trees** move to a versioned store (`treetime.saved.v2`). The old keys are read and
  **left in place**, so rolling back loses nothing. Tested with the captured fixture.
- **Loading:** zoomed in (13.5 and closer) the app loads every tree in view by map tile, once per
  source, and filters in the browser. Tiles are kept in memory and in IndexedDB for six hours.
  Filter changes and panning back make no requests. Zoomed out it works as before.
- **Source filter**, source on the card, "About the data", and a coverage note.
- **Tests:** 33 unit tests and 17 browser tests (run at desktop and phone sizes) against a mock
  of the city's service built from real records.

## 6. Design critique

*Added in Phase 2.*
