import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIXTURE_CENTER, clickTree, jumpTo, mockNetwork, pillText, ready, shownIds, tt } from './mock.js';
import { all, count, fmt, park, street, unique } from './expected.js';

const fixture = (n) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url))));
const isPhone = (testInfo) => testInfo.project.name === 'phone';
// On phones the filters live in a bottom sheet: open it before using them.
async function openPanel(page, testInfo) {
  if (isPhone(testInfo) && (await page.locator('#sheet').getAttribute('data-state')) !== 'expanded') {
    await page.locator('#grab').click();
    await expect(page.locator('#sheet')).toHaveAttribute('data-state', 'expanded');
  }
}
async function closePanel(page, testInfo) {
  if (isPhone(testInfo) && (await page.locator('#sheet').getAttribute('data-state')) === 'expanded') {
    await page.locator('#grab').click();
    await expect(page.locator('#sheet')).toHaveAttribute('data-state', 'collapsed');
  }
}

test.describe('map loading', () => {
  test('loads trees from every source, each real tree once, with no errors', async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const net = await mockNetwork(page);
    await ready(page);
    const ids = await shownIds(page);
    expect(ids.length).toBe(unique(all).length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.startsWith('sdot:'))).toBe(true);
    expect(ids.some((id) => id.startsWith('spr:'))).toBe(true);
    // removed street trees, snags and park records with no status never load
    expect(ids).not.toContain('spr:' + fixture('spr-queen-anne.json').features.find((f) => f.attributes.STATUS === 'Snag').attributes.TREE_ID);
    expect(ids.filter((id) => id.startsWith('sdot:')).length).toBeLessThanOrEqual(street.length);
    await openPanel(page, testInfo);
    await expect(page.locator('.chip[data-source=sdot] small')).toHaveText(fmt(street.length));
    await expect(page.locator('.chip[data-source=spr] small')).toHaveText(fmt(park.length));
    await expect(page.locator('.chip[data-family=maple] small')).toHaveText(fmt(count(all, { families: new Set(['maple']) })));
    // pagination: the mock serves 100 records a page, so later pages must have been requested
    expect(net.requests.some((r) => r.offset === '100')).toBe(true);
    expect(errors).toEqual([]);
  });

  test('zoomed in, trees load by map tile and are cached: panning back makes no requests', async ({ page }) => {
    const net = await mockNetwork(page);
    await ready(page);
    await jumpTo(page, FIXTURE_CENTER, 16);
    await page.waitForFunction(() => window.__treetime.viewMode === 'tiles' && window.__treetime.shown.length > 0);
    expect(net.requests.filter((r) => r.kind === 'tile').length).toBeGreaterThan(0);
    expect((await shownIds(page)).length).toBe(unique(all).length);
    const before = net.requests.length;
    await tt(page, () => window.__treetime.map.panBy([120, 0], { animate: false }));
    await page.waitForTimeout(700);
    await tt(page, () => window.__treetime.map.panBy([-120, 0], { animate: false }));
    await page.waitForTimeout(700);
    expect(net.requests.slice(before).filter((r) => r.kind === 'tile' || r.kind === 'features')).toEqual([]);
  });

  test('says so when the tree service is unreachable, and recovers', async ({ page }) => {
    const net = await mockNetwork(page);
    net.fail = true;
    await page.goto('./');
    await expect(page.locator('#pill')).toContainText(/Couldn't (reach|load)/);
    net.fail = false;
    await tt(page, () => window.__treetime.map.panBy([40, 0], { animate: false }));
    await page.waitForFunction(() => window.__treetime.shown.length > 0);
  });

  test('shows a loading message while a slow request is in flight', async ({ page }) => {
    const net = await mockNetwork(page);
    net.delayMs = 1500;
    await page.goto('./');
    await expect(page.locator('#pilltext')).toHaveText('Loading trees…');
    net.delayMs = 0;
  });
});

test.describe('filters', () => {
  test('family, size, species and clear', async ({ page }, testInfo) => {
    await mockNetwork(page);
    await ready(page);
    await openPanel(page, testInfo);

    await page.locator('.chip[data-family=maple]').click();
    const maples = { families: new Set(['maple']) };
    await expect(page.locator('#pill')).toContainText(`${fmt(count(all, maples))} maples`);
    await expect.poll(async () => (await shownIds(page)).length).toBe(count(unique(all), maples));

    await page.locator('#sizes button', { hasText: 'Mature' }).click();
    const mature = { ...maples, dmin: 18, dmax: 35 };
    await expect(page.locator('#pill')).toContainText(`${fmt(count(all, mature))} maple`);
    await expect(page.locator('#pill')).toContainText('18–35″');
    await expect(page.locator('#rangeout')).toHaveText('18–35 in');

    await page.locator('#pillclear').click();
    await expect.poll(async () => (await shownIds(page)).length).toBe(unique(all).length);
    await expect(page.locator('.chip[aria-pressed=false]')).toHaveCount(0);

    // species search is the species filter
    await page.locator('#q').fill('horse');
    await expect(page.locator('#suggest .opt').first()).toContainText('Horse Chestnut');
    await page.keyboard.press('Enter');
    const horse = { species: 'Horse Chestnut' };
    await expect(page.locator('#pill')).toContainText(`${fmt(count(all, horse))} trees`);
    await expect(page.locator('#pill')).toContainText('Horse Chestnut');
    await expect.poll(async () => (await shownIds(page)).length).toBe(count(unique(all), horse));
    await page.locator('#qclear').click();
    await expect(page.locator('#q')).toHaveValue('');
  });

  test('size filters leave out trees whose diameter is not recorded (the 555″ hawthorn)', async ({ page }, testInfo) => {
    await mockNetwork(page);
    await ready(page);
    expect(await shownIds(page)).toContain('sdot:TRE-BAD-1');
    await openPanel(page, testInfo);
    await page.locator('#sizes button', { hasText: 'Giant' }).click();
    await expect(page.locator('#pill')).toContainText(`${fmt(count(all, { dmin: 50, dmax: null }))} tree`);
    await expect.poll(async () => await shownIds(page)).not.toContain('sdot:TRE-BAD-1');
  });

  test('source filter: each source can be hidden, and at least one stays on', async ({ page }, testInfo) => {
    await mockNetwork(page);
    await ready(page);
    await openPanel(page, testInfo);
    await page.locator('.chip[data-source=spr]').click();
    await expect(page.locator('#pill')).toContainText(`${fmt(street.length)} street trees`);
    await expect.poll(async () => (await shownIds(page)).every((id) => id.startsWith('sdot:'))).toBe(true);
    // a street tree hidden as a duplicate of nothing: all street trees show when parks are off
    await expect.poll(async () => (await shownIds(page)).length).toBe(street.length);
    // turning off the last source switches to the other one
    await page.locator('.chip[data-source=sdot]').click();
    await expect(page.locator('.chip[data-source=spr]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.chip[data-source=sdot]')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await shownIds(page)).length).toBe(park.length);
    await expect(page.locator('#pill')).toContainText(`${fmt(park.length)} park trees`);
  });

  test('zoomed in, a filter change redraws from loaded trees without refetching them', async ({ page }, testInfo) => {
    const net = await mockNetwork(page);
    await ready(page);
    await jumpTo(page, FIXTURE_CENTER, 16);
    await page.waitForFunction(() => window.__treetime.viewMode === 'tiles' && window.__treetime.shown.length > 0);
    await openPanel(page, testInfo);
    const before = net.requests.length;
    await page.locator('.chip[data-family=cherry]').click();
    await expect.poll(async () => (await shownIds(page)).length).toBe(count(unique(all), { families: new Set(['cherry']) }));
    await page.waitForTimeout(500);
    expect(net.requests.slice(before).filter((r) => r.kind === 'tile' || r.kind === 'features')).toEqual([]);
  });
});

test.describe('tree card', () => {
  test('shows the source, and a tree in two inventories appears once', async ({ page }, testInfo) => {
    await mockNetwork(page);
    await ready(page);
    await jumpTo(page, FIXTURE_CENTER, 18);
    await page.waitForFunction(() => window.__treetime.viewMode === 'tiles' && window.__treetime.shown.some((t) => t.id === 'sdot:TRE-33477'));
    const ids = await shownIds(page);
    expect(ids).not.toContain('spr:15348');
    await closePanel(page, testInfo);
    await clickTree(page, 'sdot:TRE-33477');
    await expect(page.locator('#card')).toBeVisible();
    await expect(page.locator('#cname')).toHaveText('Horse Chestnut');
    await expect(page.locator('#cdl')).toContainText('Street tree (SDOT); also in the park tree inventory');
    await expect(page.locator('#cdl')).toContainText('2405 NOB HILL AV N');
    await expect(page.locator('#clink')).toHaveAttribute('href', /google\.com\/maps\/search\/\?api=1&query=47\.6401\d,-122\.3509\d/);
  });

  test('bad records are shown calmly: no size, no future planting date, no name', async ({ page }, testInfo) => {
    await mockNetwork(page);
    await ready(page);
    await jumpTo(page, [-122.3525, 47.639], 19);
    await page.waitForFunction(() => window.__treetime.shown.some((t) => t.id === 'sdot:TRE-BAD-1'));
    await closePanel(page, testInfo);
    await clickTree(page, 'sdot:TRE-BAD-1');
    await expect(page.locator('#cdl')).toContainText('Not recorded');
    await expect(page.locator('#cdl')).not.toContainText('Planted');
    await expect(page.locator('#cdl')).not.toContainText('555');
    await page.locator('#cardx').click();
    await clickTree(page, 'sdot:TRE-BAD-2');
    await expect(page.locator('#cname')).toHaveText('Unknown species');
    await expect(page.locator('#cdl')).toContainText('City Heritage Tree');
  });

  test('a park tree shows its park and source', async ({ page }, testInfo) => {
    await mockNetwork(page);
    await ready(page);
    await openPanel(page, testInfo);
    await page.locator('.chip[data-source=sdot]').click(); // parks only
    await expect.poll(async () => (await shownIds(page)).length).toBe(park.length);
    const first = park[0];
    await jumpTo(page, [first.lng, first.lat], 19);
    await page.waitForFunction((id) => window.__treetime.viewMode === 'tiles' && window.__treetime.shown.some((t) => t.id === id), first.id);
    await closePanel(page, testInfo);
    await clickTree(page, first.id);
    await expect(page.locator('#cdl')).toContainText('Park tree (Seattle Parks)');
    if (first.place) await expect(page.locator('#cdl')).toContainText(first.place);
  });
});

test.describe('saved trees', () => {
  test('save, name, reload, remove', async ({ page }, testInfo) => {
    await mockNetwork(page);
    await ready(page);
    await jumpTo(page, FIXTURE_CENTER, 18);
    await page.waitForFunction(() => window.__treetime.shown.some((t) => t.id === 'sdot:TRE-33477'));
    await closePanel(page, testInfo);
    await clickTree(page, 'sdot:TRE-33477');
    await page.locator('#cfav').click();
    await expect(page.locator('#cfav')).toHaveText('★ Saved');
    await expect(page.locator('#savedcount')).toHaveText('1');
    await expect(page.locator('#csince')).toContainText('Saved since');

    await page.locator('#cnamebtn').click();
    await page.keyboard.type('Mr. O’Leary 🌳');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cname')).toHaveText('Mr. O’Leary 🌳');

    await page.reload();
    await page.waitForFunction(() => window.__treetime && window.__treetime.saved.length === 1);
    expect(await tt(page, () => window.__treetime.saved[0].id)).toBe('sdot:TRE-33477');
    await openPanel(page, testInfo);
    await page.locator('#tab-saved').click();
    await expect(page.locator('#favs .fav b')).toHaveText('Mr. O’Leary 🌳');
    await expect(page.locator('#favs .fav small')).toContainText('Horse Chestnut');

    await page.locator('#favs .fav-x').click();
    await expect(page.locator('#favs')).toContainText('No saved trees yet');
    expect(await tt(page, () => JSON.parse(localStorage.getItem('treetime.saved.v2')).length)).toBe(0);
  });

  test('a tree saved from the park inventory stays saved when shown as its street duplicate', async ({ page }, testInfo) => {
    await mockNetwork(page);
    await page.goto('./');
    // saved earlier as the park record, before the street record was known to be the same tree
    await page.evaluate((tree) => localStorage.setItem('treetime.saved.v2', JSON.stringify([{ id: tree.id, tree, savedAt: 5, since: 5, name: 'Conker', gone: false }])),
      park.find((t) => t.id === 'spr:15348'));
    await page.reload();
    await ready(page);
    await jumpTo(page, FIXTURE_CENTER, 18);
    await page.waitForFunction(() => window.__treetime.shown.some((t) => t.id === 'sdot:TRE-33477'));
    await closePanel(page, testInfo);
    await clickTree(page, 'sdot:TRE-33477');
    await expect(page.locator('#cfav')).toHaveText('★ Saved');
    await expect(page.locator('#cname')).toHaveText('Conker');
    expect(await tt(page, () => window.__treetime.saved[0].id)).toBe('spr:15348');
  });

  test('"Show only these on map" limits the map to saved trees', async ({ page }, testInfo) => {
    await mockNetwork(page);
    await page.goto('./');
    await page.evaluate((trees) => localStorage.setItem('treetime.saved.v2', JSON.stringify(trees.map((tree, i) => ({ id: tree.id, tree, savedAt: i + 1, since: i + 1, name: '', gone: false })))), [street[0], park[3]]);
    await page.reload();
    await ready(page);
    await openPanel(page, testInfo);
    await page.locator('#tab-saved').click();
    await page.locator('#savedonlywrap').click();
    await expect(page.locator('#pill')).toContainText('2 saved trees');
    await expect.poll(async () => (await shownIds(page)).sort()).toEqual([street[0].id, park[3].id].sort());
  });
});

test.describe('saves from earlier versions', () => {
  test('trees saved by the current live version load, show and work after the update', async ({ page }, testInfo) => {
    const legacy = [...fixture('saved-v1-from-app.json').favoriteTrees, ...fixture('saved-legacy-shapes.json').favoritesFirstVersion];
    await mockNetwork(page);
    await page.goto('./');
    await page.evaluate((recs) => { localStorage.clear(); localStorage.setItem('favoriteTrees', JSON.stringify(recs)); }, legacy);
    await page.reload();
    await page.waitForFunction((n) => window.__treetime && window.__treetime.saved.length === n, legacy.length);

    await expect(page.locator('#savedcount')).toHaveText(String(legacy.length));
    await openPanel(page, testInfo);
    await page.locator('#tab-saved').click();
    await expect(page.locator('#favs .fav')).toHaveCount(legacy.length);
    await expect(page.locator('#favs')).toContainText('Mr. O’Leary 🌳');
    await expect(page.locator('#favs')).toContainText('Coast Redwood');
    // the old data is left in place, and the new store uses stable source ids
    expect(await tt(page, () => JSON.parse(localStorage.getItem('favoriteTrees')).length)).toBe(legacy.length);
    const ids = await tt(page, () => JSON.parse(localStorage.getItem('treetime.saved.v2')).map((r) => r.id));
    expect(ids.sort()).toEqual(legacy.map((r) => `sdot:${r.a.UNITID}`).sort());

    // a saved tree still in the city's data is refreshed and not marked gone...
    const chestnut = page.locator('#favs .fav', { hasText: 'Horse Chestnut' });
    await expect(chestnut.locator('.gone-note')).toBeHidden();
    // ...and one that isn't (not in the fixture) is kept and marked
    await expect(page.locator('#favs .fav', { hasText: 'Mr. O’Leary' }).locator('.gone-note')).toBeVisible();

    // opening a migrated tree shows its card, and it stays open
    await chestnut.locator('.fav-open').click();
    await expect(page.locator('#card')).toBeVisible();
    await expect(page.locator('#cfav')).toHaveText('★ Saved');
    await page.waitForFunction(() => window.__treetime.viewMode === 'tiles' && window.__treetime.shown.length > 0);
    await page.waitForTimeout(600);
    await expect(page.locator('#card')).toBeVisible();
    await expect(page.locator('#cdl')).toContainText('2405 NOB HILL AV N');
  });
});

test.describe('accessibility basics', () => {
  test('every button has an accessible name, and the page has one h1', async ({ page }, testInfo) => {
    await mockNetwork(page);
    await ready(page);
    await openPanel(page, testInfo);
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, a[href], input, [role=tab]')]
      .filter((e) => e.getClientRects().length)
      .filter((e) => !(e.getAttribute('aria-label') || e.innerText.trim() || e.title || (e.labels && e.labels.length) || e.placeholder))
      .map((e) => e.outerHTML.slice(0, 80)));
    expect(unnamed).toEqual([]);
    await expect(page.locator('h1')).toHaveCount(1);
  });

  test('filters work from the keyboard', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'keyboard path is checked on desktop');
    await mockNetwork(page);
    await ready(page);
    await page.locator('.chip[data-family=oak]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.chip[data-family=oak]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.chip[data-family=maple]')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#tab-explore').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tab-saved')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#aboutbtn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#about')).toBeVisible();
    await expect(page.locator('#about-sources li')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('#about')).toBeHidden();
  });
});
