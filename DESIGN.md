# Design reference: TreeTime

The principle behind every choice: **relationships with trees, not ownership.** Nothing in the
interface claims, ranks, counts people, or rewards streaks.

## Tokens

All colour, type size, spacing, radius and shadow values live at the top of `style.css`, in two layers.

1. **Palette.** The only place a raw colour is written (`--stone-100`, `--moss-600`, `--night-700`…).
   Components never use these.
2. **Semantic tokens.** What components use. Light and dark themes differ only in how these point at
   the palette. Dark is defined twice, once for the system setting and once for the theme button; a
   test checks the two stay identical.

A test (`tests/unit/tokens.test.js`) fails if a component uses a hex colour or a raw type size, if a
token is used but not defined, or if a text or control colour pair drops below WCAG AA.

### Colour

| Token | Use |
| --- | --- |
| `--surface-page` | Page background and input wells |
| `--surface-raised` | Sidebar, bottom sheet, card, pill, dialog |
| `--surface-chip` | Chips, hover fills, count badges |
| `--surface-map` | Behind the map while it loads |
| `--content-primary` | Text |
| `--content-secondary` | Labels, counts, secondary lines (at least 4.5:1 on every surface) |
| `--content-border-color` | Dividers and the edges of surfaces |
| `--control-border-color` | An outline that is the only edge of a control: search field, size buttons, an unselected chip (at least 3:1) |
| `--accent` | Moss green. Selected states, links, the slider, focus rings. Nothing else |
| `--accent-content` | Text on the accent |
| `--family-maple` … `--family-other` | Tree families: map dots and chip swatches only, never interface chrome |
| `--map-ground`, `--map-road-minor`, `--map-park`, `--map-water`, `--map-label`… | The basemap. `js/app.js` reads these and recolours the map style, so the map follows the theme with no colours in the script |

Neutrals are cool and slightly green. There is no pure grey, and white appears only as roads and as text on the accent.

### Type

Bricolage Grotesque 700 for the title and headings (`--font-display`), IBM Plex Sans for everything
else (`--font-body`), IBM Plex Mono with tabular numbers for counts, sizes and coordinates (`--font-mono`).

| Token | Size | Use |
| --- | --- | --- |
| `--text-xs` | 12px | Field labels, map scale. Nothing is smaller |
| `--text-mono` | 12.5px | Counts and ranges in mono |
| `--text-sm` | 13px | Chips, pill, secondary lines |
| `--text-md` | 14px | Controls, card rows, list rows |
| `--text-base` | 15px | Body, search field |
| `--text-input` | 16px | Text fields on phones (a smaller field makes iOS zoom the page) |
| `--text-lg` | 19px | Card heading, phone title |
| `--text-title` | 20px | Dialog heading |
| `--text-xl` | 25px | TreeTime |

`--weight-small` is the weight for text under 13px: 400 in light, 500 in dark.

### Spacing and shape

A 4px scale with half steps: `--space-1` (4px) to `--space-6` (24px), written `--space-1h` for 6px and
so on. Radii: `--radius-sm` 6, `--radius-md` 8, `--radius-lg` 12, `--radius-xl` 16, `--radius-pill`.
`--tap` is 44px, the smallest tap target on a phone.

## Layout

- **Desktop:** a fixed 340px sidebar on the left and a full-height map. The Explore tab fits without
  scrolling at 800px tall.
- **Phone (760px and under):** a full-screen map with the sidebar as a bottom sheet. Collapsed, it
  shows the title, the tabs and the search field. The handle is a button: tap it, drag it, or press
  Enter.
- **Sidebar:** title, theme button, About; then Explore and Saved tabs. Explore has the species
  search, source chips, family chips, and size presets with a Custom slider. Saved has the list and
  "Show only these on map".

## Phone rules

- Every control is at least 44×44px. A test measures them.
- The filter pill sits at the top left and stops short of the zoom buttons. It wraps to two lines
  before it truncates.
- The tree card spans the screen above the sheet. Its last row holds the Google Maps link on the
  left and the actions on the right, each a full-size button. **There is room in that row for one
  more action** (the heart planned for the next run), and the heading already swaps to a nickname
  with the species below it.
- The card leaves out the coordinates on a phone; the Google Maps link covers that.
- There is no north arrow on a phone. The map never rotates, and the arrow looked like a button.

## Map

- Dots are sized by trunk diameter and coloured by family, with a 1px halo in the ground colour.
  The largest are drawn first so small trees sit on top.
- From zoom 13.5 every tree in view is shown. Zoomed out, dots show only when 3,000 or fewer trees
  match; otherwise the pill says "Zoom in to see individual trees".
- Controls: zoom in, zoom out and reset at the top right; a metric scale at the bottom left.
- Hovering a dot shows its name and size. Clicking opens the card.
- Seattle only: the map opens on the whole city, cannot zoom out past it, and stops about 10% past
  the edge. Everything outside the city sits under a mask in the ground colour, with a 1px outline.
- The basemap is OpenFreeMap vector tiles drawn by MapLibre, recoloured from the `--map-*` tokens so
  it recedes. Street names stay above the trees.

## Interaction

- Family chips: clicking one while all are on shows only that family; after that, clicks add or
  remove. "Show all" resets.
- Source chips: at least one stays on.
- Size presets: Young <6″, Medium 6–17″, Mature 18–35″, Large 36–49″, Giant 50″+. Clicking the
  active one clears it.
- The pill describes the result in plain words ("1,204 maples · 18–35″ · Clear filters") and carries
  loading, empty and error messages in the same place.
- The card names the tree's source. A tree in two inventories says so.

## Copy

Plain and specific. Name things the way a resident would ("Trunk diameter", "Park trees"), never by
database field. Say "Not recorded" for a missing value. Sentence case everywhere.
