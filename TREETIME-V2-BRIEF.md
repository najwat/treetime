# TreeTime v2 — build brief

You're working on TreeTime, a small web app on Seattle's SDOT street tree data, live at najwat.com/treetime (GitHub Pages, served from this repo). This is a long, autonomous run. Plan the work, build it, check your own results, and keep going until everything below is done or you hit a stop point marked **STOP**.

This run covers the foundations: **data and design**. The relationship features (crushes, names, share links) come in a later run, on top of what you build here. They're described at the end so you can make room for them, but don't build them now.

## The principle (read this first)

TreeTime is about **relationships with trees, not ownership of them.** You can save a tree, give it a private name, and have a crush on it. Nobody claims a tree, nobody competes, and nothing you do with a tree takes it away from anyone else.

Every decision in this run should pass that test. If something would introduce claiming, ranking, leaderboards, streaks, public profiles or "first to find" mechanics, don't build it.

## Phase 0 — Audit what exists (do this before writing any code)

1. Read the whole repo, including `DESIGN.md` and any reference HTML. Run the app locally and open it in a browser at 390px and 1280px wide, in light and dark mode.
2. Write `docs/AUDIT.md` with:
   - what's already built (filters, map, saving/favorites, theme switcher, anything else), and how each works
   - how data is loaded (the SDOT ArcGIS layer caps at 2,000 records per request, so check the pagination), where saved trees are stored (likely localStorage) and in what shape, and the map library
   - bugs and rough edges you find, with screenshots. Check these in particular: the "Google Maps ↗" link (does it point to the tree, or to `#`?), the unlabeled "N" map control, whether the diameter filter shows its range and units, what the map shows while trees are loading or when a filter returns nothing, whether Favorites shows a count, how dense map dots look when zoomed out, and whether dark-mode text is large and heavy enough to read comfortably (not just technically passing contrast)
3. Don't rebuild anything that already works unless a phase below calls for it.

## Phase 1 — Data

1. **A shared tree format.** Put SDOT loading behind a small adapter that converts records into one TreeTime format: a stable id, source, common name, genus, family, diameter in inches, latitude/longitude, planted date when available. The rest of the app should never need to know which source a tree came from. This is what makes Parks trees, and other cities later, easy to add.
2. **Existing saves must survive.** People already have saved trees on the live site. Whatever id scheme you choose, every tree saved before this change must still load, show and work afterwards. Write a migration for the stored data if needed, and test it with a saved-trees fixture taken from the current code.
3. **Data quality.** Diameters over 80″ are treated as not recorded (the data has 555″ hawthorns). Keep that rule in the adapter, and look for other obvious errors the same way (impossible dates, missing species). Handle them quietly, without showing errors to users.
4. **Seattle Parks trees (if available).** Find out whether Seattle publishes a public dataset of park trees with species and location. If it does and it's usable, add it as a second adapter, with a source toggle in the filters. If it doesn't, or it's poor quality, skip it and write down what you found in `docs/AUDIT.md`. Update the "Park and private-yard trees aren't in this dataset" note to match whatever is true afterwards.
5. **Performance.** Make sure the full dataset stays smooth to pan, zoom and filter on a mid-range phone. Cache loaded data sensibly so repeat visits are fast, without serving stale data for long.

## Phase 2 — Refine the design

The current look is a good base. Refine it, don't replace it: keep the Bricolage Grotesque / IBM Plex type, the moss-green accent and the family-colored map dots unless you have a strong reason, and write the reason down.

1. **Critique first.** Add a "Design critique" section to `docs/AUDIT.md` covering hierarchy, spacing, the filter row, the tree card, map dot density and color at different zooms, the empty and loading states, tap target sizes, and dark mode. Rank the issues by how much they hurt the experience.
2. **Tokens, not hex.** Move every color into CSS custom properties, starting at a semantic level (for example `--content-border-color`, `--surface-raised`, `--accent`) and mapped to a small palette. No hard-coded hex values in components. Light and dark mode should differ only in how the tokens are defined. Do the same for type sizes and spacing if it isn't done already, and update `DESIGN.md` to document the tokens.
3. **Refine one viewport only: mobile, 390px wide.** Fix the top issues from your critique on the existing surfaces (filters, map, tree card, save button, favorites, theme switcher, and the source toggle if Parks data was added). Read "Next run" below and leave room for those features. For example, the tree card should be able to take a heart and a name later without a redesign. But don't build them. Don't change the desktop layout's design in this run beyond what the token migration requires, and make sure nothing there breaks.
4. Take before/after screenshots at 390px in light and dark mode and put them in `docs/design/`.

**STOP after Phase 2.** Najwat will review the mobile refinement before it's carried to desktop, and before the relationship features are built.

## Next run (don't build now; design with these in mind)

These come later, built on the adapter and tokens from this run:

- **Crush.** The favorite action becomes a heart, and a hearted tree is a "crush," with a "Crush since Nov 2026" date on its card.
- **Names.** A private nickname for any saved tree. When a crush has no name, a subtle prompt on its card: "It's getting serious. Give them a name?"
- **My trees list.** A view of your crushes and named trees, with a count and sorting.
- **Share links.** A link that opens the map on a specific tree, carrying its nickname, with the option for the recipient to save it to their own list.
- **Trees that disappear** from the city's data stay in your list, marked "No longer in the city's inventory."
- **Export/import** of your trees as a JSON file.

## Out of scope for this run

- Everything in "Next run" above.
- Accounts, sign-in or any backend. Instead, write `docs/ACCOUNTS-PROPOSAL.md`: 2–3 options for syncing a person's trees across devices (for example Supabase, Firebase, or a Cloudflare Worker + KV), with rough cost at small scale, privacy implications, and what it would take to add to a static GitHub Pages site. Recommend one. Don't build it.
- Claiming, leaderboards, scores, streaks, public profiles, comments, AI "talk to a tree" features.
- Other cities (the adapter makes them possible later, but don't add them).
- Renaming the app or changing the domain. The name is undecided, so keep "TreeTime."

## How to work

- Work on branches and open **one pull request per phase** (Phase 0 can be bundled with Phase 1), each with a short description of what changed and screenshots. **Don't merge into main**: main deploys straight to the live site, and Najwat merges.
- Add automated checks that actually run: Playwright tests for the filters, map loading and saving, plus tests that the adapter handles bad records and that saved trees from the current version migrate correctly. Run them before every PR and fix what fails.
- Check accessibility on everything you touch: WCAG 2.1 AA contrast in both themes, keyboard access, labels on icon-only controls (like "N" and ⤢), and tap targets at least 44px on mobile.
- Keep it a static site that works on GitHub Pages. Add libraries only when they clearly earn their place, and note why in the PR.
- If something in this brief turns out to be wrong once you see the code (for example, a feature already works differently than described), follow the principle, make a sensible call, and write down what you decided and why in the PR.

## Done means

- `docs/AUDIT.md` (audit, data findings, design critique), `docs/ACCOUNTS-PROPOSAL.md`, and updated `DESIGN.md`
- PRs for Phases 1 and 2, each with tests passing and screenshots
- Mobile before/after screenshots in `docs/design/`
- A final summary: what was built, what you skipped and why, open questions, and what you'd recommend for the next run
