/* Seattle Street Trees: plain JS, no build step.
   Look and behavior follow DESIGN.md and reference/prototype.html. */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  const CONFIG = {
    layerUrl: 'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/SDOT_Trees_CDL/FeatureServer/0',
    statusField: 'CURRENT_STATUS',
    statusValue: 'INSVC',

    // Field names are matched against the layer's own metadata at startup.
    fields: {
      common:     { candidates: ['COMMON_NAME', 'COMMONNAME'], pattern: /common/i },
      scientific: { candidates: ['SCIENTIFIC_NAME', 'SCIENTIFIC'], pattern: /scien|botan/i },
      diameter:   { candidates: ['DIAM', 'DBH', 'DIAMETER'], pattern: /diam|dbh/i },
      address:    { candidates: ['UNITDESC', 'ADDRESS'], pattern: /addr/i },
      planted:    { candidates: ['PLANTED_DATE', 'PLANTDATE'], pattern: /plant.*date/i },
    },

    maxDiameter: 80,    // inches; larger values are data-entry errors -> "Not recorded"
    sliderMax: 72,      // top slider stop means "72 and larger"
    areaLimit: 3000,    // above this many matches in view, ask the user to zoom in
    listTop: 12,        // species shown before "Show all"
    home: { center: [47.6145, -122.3360], zoom: 12 },
    detailZoom: 17,

    // CARTO basemaps key. It ships to every visitor's browser, so restrict it
    // to this site's domain in the CARTO dashboard.
    cartoKey: 'cb1_4zwi_1_5f45bb3f199208a216762f99',
  };

  // Tree families, as in the prototype. Conifers also include a few Seattle
  // genera the prototype's small sample didn't contain (Douglas-fir etc.).
  const FAMS = [
    { id: 'maple',   name: 'Maples',           g: ['Acer'] },
    { id: 'cherry',  name: 'Cherries & plums', g: ['Prunus'] },
    { id: 'pear',    name: 'Pears & apples',   g: ['Pyrus', 'Malus'] },
    { id: 'ash',     name: 'Ashes',            g: ['Fraxinus'] },
    { id: 'birch',   name: 'Birches',          g: ['Betula'] },
    { id: 'oak',     name: 'Oaks',             g: ['Quercus'] },
    { id: 'conifer', name: 'Conifers',         g: ['Thuja', 'Juniperus', 'Chamaecyparis', 'Cedrus', 'Pinus', 'Picea', 'Abies', 'Tsuga',
                                                   'Sequoia', 'Sequoiadendron', 'Metasequoia', 'Cupressus', 'Pseudotsuga', 'Calocedrus',
                                                   'Cryptomeria', 'Larix', 'Taxodium', 'Taxus'] },
    { id: 'other',   name: 'Everything else',  g: [] },
  ];
  const OTHER = FAMS.length - 1;
  const famOfGenus = {};
  FAMS.forEach((f, i) => f.g.forEach((g) => { famOfGenus[g] = i; }));

  const SIZES = [
    { n: 'Young',  r: [0, 5],   l: '<6″' },
    { n: 'Medium', r: [6, 17],  l: '6–17″' },
    { n: 'Mature', r: [18, 35], l: '18–35″' },
    { n: 'Giant',  r: [36, CONFIG.sliderMax], l: '36″+' },
  ];

  // ---------------------------------------------------------------------------
  // State & helpers
  // ---------------------------------------------------------------------------
  const state = {
    f: {}, oid: 'OBJECTID', maxRec: 2000,
    fams: new Set(FAMS.map((_, i) => i)),
    dmin: 0, dmax: CONFIG.sliderMax,
    sp: null, q: '', showAll: false,
    sel: null,            // selected feature
    total: null,          // all in-service trees
    match: null,          // trees matching current filters
  };
  let speciesRows = [];   // [{name, count}] for current family/size filters
  const speciesInfo = new Map(); // common name -> {sci, fam}

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat('en-US');
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sql = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const attr = (a, name) => {
    if (!name) return undefined;
    if (name in a) return a[name];
    const k = Object.keys(a).find((x) => x.toUpperCase() === name.toUpperCase());
    return k ? a[k] : undefined;
  };

  function genusOf(sci) {
    if (!sci) return '';
    const parts = String(sci).trim().split(/\s+/);
    return (parts[0] === 'x' || parts[0] === '×') ? (parts[1] || '') : parts[0];
  }
  const famOfSci = (sci) => famOfGenus[genusOf(sci)] ?? OTHER;

  // Recorded diameter in inches, or null when missing / zero / implausibly large.
  function diamOf(a) {
    const d = Number(attr(a, state.f.diameter));
    return d > 0 && d <= CONFIG.maxDiameter ? d : null;
  }
  const fmtIn = (d) => (Number.isInteger(d) ? String(d) : d.toFixed(1));

  // ---------------------------------------------------------------------------
  // ArcGIS REST
  // ---------------------------------------------------------------------------
  async function arcgis(path, params, signal) {
    const qs = new URLSearchParams({ f: 'json', ...params });
    const res = await fetch(`${CONFIG.layerUrl}${path}?${qs}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Query failed');
    return data;
  }
  const query = (params, signal) => arcgis('/query', params, signal);

  // Fetch every page of a query (features or grouped statistics).
  async function queryAll(params, signal, cap = Infinity) {
    const out = [];
    for (;;) {
      const p = out.length ? { ...params, resultOffset: String(out.length) } : params;
      const r = await query(p, signal);
      const feats = r.features || [];
      out.push(...feats);
      if (!r.exceededTransferLimit || !feats.length || out.length >= cap) return out;
    }
  }

  const ctl = {};
  function fresh(key) {
    ctl[key]?.abort();
    ctl[key] = new AbortController();
    return ctl[key].signal;
  }

  function resolveFields(fields) {
    const byName = new Map(fields.map((f) => [f.name.toUpperCase(), f]));
    const out = {};
    for (const [key, spec] of Object.entries(CONFIG.fields)) {
      let hit = spec.candidates.map((c) => byName.get(c.toUpperCase())).find(Boolean);
      if (!hit && spec.pattern) hit = fields.find((f) => spec.pattern.test(f.name) || spec.pattern.test(f.alias || ''));
      if (hit) out[key] = hit.name;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Where clause
  // ---------------------------------------------------------------------------
  const sizeActive = () => state.dmin > 0 || state.dmax < CONFIG.sliderMax;
  const allFams = () => state.fams.size === FAMS.length;

  function genusClause(g) {
    const S = state.f.scientific;
    return `${S} = ${sql(g)} OR ${S} LIKE ${sql(g + ' %')}`;
  }
  function famClause(i) {
    if (i !== OTHER) return `(${FAMS[i].g.map(genusClause).join(' OR ')})`;
    const known = FAMS.flatMap((f) => f.g).map(genusClause).join(' OR ');
    return `(${state.f.scientific} IS NULL OR NOT (${known}))`;
  }

  function buildWhere({ species = true } = {}) {
    const { diameter: D, common: C } = state.f;
    const p = [`${CONFIG.statusField} = ${sql(CONFIG.statusValue)}`];
    if (!allFams() && state.f.scientific) p.push(`(${[...state.fams].map(famClause).join(' OR ')})`);
    if (sizeActive() && D) {
      // Size filters only consider trees with a recorded, plausible diameter.
      p.push(`${D} > 0`, `${D} <= ${CONFIG.maxDiameter}`);
      if (state.dmin > 0) p.push(`${D} >= ${state.dmin}`);
      if (state.dmax < CONFIG.sliderMax) p.push(`${D} < ${state.dmax + 1}`);
    }
    if (species && state.sp && C) p.push(`${C} = ${sql(state.sp)}`);
    return p.join(' AND ');
  }

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------
  const root = document.documentElement;
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => root.dataset.theme === 'dark' || (root.dataset.theme !== 'light' && darkMq.matches);
  let famColors = [], ink = '#1d2a22';
  function readColors() {
    const c = getComputedStyle(root);
    famColors = FAMS.map((f) => c.getPropertyValue('--f-' + f.id).trim());
    ink = c.getPropertyValue('--ink').trim();
  }
  readColors();

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------
  const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: false })
    .setView(CONFIG.home.center, CONFIG.home.zoom);
  L.control.attribution({ position: 'bottomright', prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 110 }).addTo(map);

  const tileUrl = () => `https://{s}.basemaps.cartocdn.com/${isDark() ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(CONFIG.cartoKey)}`;
  const tiles = L.tileLayer(tileUrl(), {
    subdomains: 'abcd',
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
  }).addTo(map);

  const renderer = L.canvas({ padding: 0.2 });
  const treeLayer = L.layerGroup().addTo(map);
  let markers = [];
  let ring = null;
  const canHover = window.matchMedia('(hover: hover)').matches;

  // Dot radius: ~2–8px by trunk diameter at street level, shrinking when zoomed out.
  function radiusFor(d) {
    const base = d ? Math.min(8, Math.max(2, 1.2 + Math.sqrt(d) * 0.75)) : 2;
    const k = Math.max(0.45, Math.min(1, 1 - (17 - map.getZoom()) * 0.15));
    return Math.max(1.2, base * k);
  }

  function drawTrees(feats) {
    treeLayer.clearLayers();
    markers = [];
    // Largest first, so smaller trees sit on top and stay clickable.
    const sorted = feats
      .filter((ft) => ft.geometry && ft.geometry.x != null)
      .map((ft) => ({ ft, d: diamOf(ft.attributes) }))
      .sort((a, b) => (b.d ?? 0) - (a.d ?? 0));
    for (const { ft, d } of sorted) {
      const a = ft.attributes;
      const fam = famOfSci(attr(a, state.f.scientific));
      const m = L.circleMarker([ft.geometry.y, ft.geometry.x], {
        renderer,
        radius: radiusFor(d),
        stroke: false,
        fillColor: famColors[fam],
        fillOpacity: 0.6,
        bubblingMouseEvents: false,
      });
      m.tree = { ft, d, fam };
      m.on('click', () => select(ft));
      if (canHover) {
        const name = attr(a, state.f.common) || 'Unknown species';
        m.bindTooltip(`${esc(name)} · ${d ? fmtIn(d) + '″' : 'diameter not recorded'}`,
          { className: 'tip', direction: 'top', offset: [0, -4], opacity: 1 });
      }
      m.addTo(treeLayer);
      markers.push(m);
    }
    ring?.bringToFront();
  }

  function restyle() {
    for (const m of markers) m.setStyle({ radius: radiusFor(m.tree.d), fillColor: famColors[m.tree.fam] });
    if (ring && state.sel) ring.setStyle({ radius: radiusFor(diamOf(state.sel.attributes)) + 4, color: ink });
  }
  map.on('zoomend', restyle);

  // Map overlay message (loading / zoom in / empty / error).
  function setMsg(text) {
    $('msg').textContent = text || '';
    $('msg').hidden = !text;
  }

  function envelope() {
    const b = map.getBounds();
    return {
      geometry: JSON.stringify({ xmin: b.getWest(), ymin: b.getSouth(), xmax: b.getEast(), ymax: b.getNorth(), spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
    };
  }

  const outFields = () => [state.oid, ...new Set(Object.values(state.f))].join(',');

  // Load the matching trees inside the visible map area.
  let ready = false; // set once the layer's fields are known
  async function loadView() {
    if (!ready) return;
    const signal = fresh('view');
    const where = buildWhere();
    const env = envelope();
    const slow = setTimeout(() => setMsg('Loading trees…'), 400);
    try {
      const { count } = await query({ where, ...env, returnCountOnly: 'true' }, signal);
      if (count > CONFIG.areaLimit) {
        drawTrees([]);
        setMsg('Zoom in to see individual trees');
        return;
      }
      const feats = count ? await queryAll({
        where, ...env,
        outFields: outFields(),
        returnGeometry: 'true',
        outSR: '4326',
        orderByFields: state.oid,
        resultRecordCount: String(state.maxRec),
      }, signal, CONFIG.areaLimit) : [];
      drawTrees(feats);
      setMsg(count ? '' : 'No matching trees in this area');

      // Close the card if the selected tree is in view but no longer matches.
      if (state.sel) {
        const id = attr(state.sel.attributes, state.oid);
        const g = state.sel.geometry;
        const inView = map.getBounds().contains([g.y, g.x]);
        if (inView && !feats.some((ft) => attr(ft.attributes, state.oid) === id)) select(null);
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      setMsg("Couldn't load trees for this area. Move the map to try again.");
    } finally {
      clearTimeout(slow);
    }
  }

  let viewTimer;
  map.on('moveend', () => { clearTimeout(viewTimer); viewTimer = setTimeout(loadView, 300); });

  $('zin').onclick = () => map.zoomIn();
  $('zout').onclick = () => map.zoomOut();
  $('zfit').onclick = () => map.setView(CONFIG.home.center, CONFIG.home.zoom);
  new ResizeObserver(() => map.invalidateSize()).observe($('main'));

  // ---------------------------------------------------------------------------
  // Detail card
  // ---------------------------------------------------------------------------
  function select(ft) {
    state.sel = ft || null;
    ring?.remove();
    ring = null;
    const card = $('card');
    if (!ft) { card.hidden = true; return; }

    const a = ft.attributes;
    const { y: lat, x: lng } = ft.geometry;
    const d = diamOf(a);
    const sci = attr(a, state.f.scientific);
    const addr = attr(a, state.f.address);
    const planted = attr(a, state.f.planted);
    const rows = [
      ['Trunk', d ? `${fmtIn(d)} in (${Math.round(d * 2.54)} cm)` : 'Not recorded'],
      ['Family', FAMS[famOfSci(sci)].name],
    ];
    if (addr) rows.push(['Address', addr]);
    if (typeof planted === 'number') rows.push(['Planted', new Date(planted).toLocaleDateString(undefined, { timeZone: 'UTC' })]);
    rows.push(['Location', `${lat.toFixed(5)}, ${lng.toFixed(5)}`]);

    $('cname').textContent = attr(a, state.f.common) || 'Unknown species';
    $('cgen').textContent = sci || 'Scientific name not recorded';
    $('cdl').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('clink').href = `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lng.toFixed(5)}`;
    card.hidden = false;

    ring = L.circleMarker([lat, lng], {
      renderer, radius: radiusFor(d) + 4, color: ink, weight: 2, fill: false, interactive: false,
    }).addTo(map);
  }
  $('cardx').onclick = () => select(null);
  map.on('click', () => select(null));

  // ---------------------------------------------------------------------------
  // Sidebar: count, family chips, size presets, slider, species list
  // ---------------------------------------------------------------------------
  function renderCount() {
    const n = state.match;
    $('n').textContent = n == null ? '…' : fmt.format(n);
    if (state.total == null) return;
    $('nlabel').textContent = n === state.total
      ? 'trees, all of them'
      : `of ${fmt.format(state.total)} trees match`;
  }

  const famsEl = $('fams');
  function buildChips(counts) {
    famsEl.innerHTML = '';
    FAMS.forEach((f, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.style.setProperty('--c', `var(--f-${f.id})`);
      b.innerHTML = `<i></i>${esc(f.name)} <small>${fmt.format(counts[i])}</small>`;
      b.onclick = () => {
        if (allFams()) state.fams = new Set([i]);
        else if (state.fams.has(i)) {
          state.fams.delete(i);
          if (!state.fams.size) state.fams = new Set(FAMS.map((_, j) => j));
        } else state.fams.add(i);
        state.sp = null;
        changed();
      };
      famsEl.appendChild(b);
    });
  }
  $('allfam').hidden = false;
  $('allfam').onclick = () => { state.fams = new Set(FAMS.map((_, i) => i)); state.sp = null; changed(); };

  const sizesEl = $('sizes');
  SIZES.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${s.n}<small>${s.l}</small>`;
    b.onclick = () => {
      if (state.dmin === s.r[0] && state.dmax === s.r[1]) { state.dmin = 0; state.dmax = CONFIG.sliderMax; }
      else { state.dmin = s.r[0]; state.dmax = s.r[1]; }
      $('dmin').value = state.dmin;
      $('dmax').value = state.dmax;
      changed();
    };
    s.el = b;
    sizesEl.appendChild(b);
  });
  $('dmin').oninput = (e) => { state.dmin = Math.min(+e.target.value, state.dmax); e.target.value = state.dmin; changed(); };
  $('dmax').oninput = (e) => { state.dmax = Math.max(+e.target.value, state.dmin); e.target.value = state.dmax; changed(); };

  function renderControls() {
    [...famsEl.children].forEach((b, i) => b.setAttribute('aria-pressed', state.fams.has(i) ? 'true' : 'false'));
    SIZES.forEach((s) => {
      const on = state.dmin === s.r[0] && state.dmax === s.r[1];
      s.el.classList.toggle('on', on);
      s.el.setAttribute('aria-pressed', String(on));
    });
    const max = CONFIG.sliderMax;
    $('rangeout').textContent = sizeActive() ? `${state.dmin}–${state.dmax >= max ? max + '+' : state.dmax} in` : 'Any size';
    $('fill').style.left = `${(state.dmin / max) * 100}%`;
    $('fill').style.width = `${((state.dmax - state.dmin) / max) * 100}%`;
    $('clearsp').hidden = !state.sp;
  }

  $('q').oninput = (e) => { state.q = e.target.value.trim().toLowerCase(); state.showAll = false; renderList(); };
  $('clearsp').onclick = () => { state.sp = null; changed({ species: false }); };
  $('more').onclick = () => { state.showAll = !state.showAll; renderList(); };

  function renderList() {
    let rows = speciesRows;
    if (state.q) {
      rows = rows.filter((r) => `${r.name} ${speciesInfo.get(r.name)?.sci || ''}`.toLowerCase().includes(state.q));
    }
    const max = rows.length ? Math.max(...rows.map((r) => r.count)) : 1;
    const lim = state.showAll || state.q ? rows.length : CONFIG.listTop;
    const list = $('list');
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = '<p>No species match. Try a different search or widen the filters.</p>';
    }
    for (const r of rows.slice(0, lim)) {
      const info = speciesInfo.get(r.name);
      const fam = info ? info.fam : OTHER;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp' + (state.sp === r.name ? ' on' : '');
      b.setAttribute('aria-pressed', String(state.sp === r.name));
      b.style.setProperty('--c', `var(--f-${FAMS[fam].id})`);
      b.innerHTML = `<i></i><span></span><em>${fmt.format(r.count)}</em><div class="bar"><b style="width:${(r.count / max) * 100}%"></b></div>`;
      b.querySelector('span').textContent = r.name;
      b.title = r.name + (info?.sci ? ` (${info.sci})` : '');
      b.onclick = () => { state.sp = state.sp === r.name ? null : r.name; changed({ species: false }); };
      list.appendChild(b);
    }
    const more = $('more');
    more.hidden = !!state.q || rows.length <= CONFIG.listTop;
    more.textContent = state.showAll ? `Show top ${CONFIG.listTop}` : `Show all ${fmt.format(rows.length)} species`;
  }

  // ---------------------------------------------------------------------------
  // Data refresh
  // ---------------------------------------------------------------------------
  async function loadCount() {
    const signal = fresh('count');
    state.match = null;
    renderCount();
    try {
      const noFilters = allFams() && !sizeActive() && !state.sp;
      state.match = noFilters && state.total != null
        ? state.total
        : (await query({ where: buildWhere(), returnCountOnly: 'true' }, signal)).count;
    } catch (e) {
      if (e.name === 'AbortError') return;
      $('nlabel').textContent = "Couldn't count trees";
    }
    renderCount();
  }

  async function loadSpecies() {
    const signal = fresh('species');
    const C = state.f.common;
    if (!C) return;
    try {
      const feats = await queryAll({
        where: `${buildWhere({ species: false })} AND ${C} IS NOT NULL`,
        groupByFieldsForStatistics: C,
        outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: state.oid, outStatisticFieldName: 'n' }]),
        orderByFields: 'n DESC',
      }, signal);
      speciesRows = feats
        .map((ft) => ({ name: attr(ft.attributes, C), count: attr(ft.attributes, 'n') }))
        .filter((r) => r.name && String(r.name).trim());
      renderList();
    } catch (e) {
      if (e.name === 'AbortError') return;
      $('list').innerHTML = "<p>Couldn't load species. Try again in a moment.</p>";
    }
  }

  let refreshTimer;
  function changed({ species = true } = {}) {
    renderControls();
    renderList();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      loadCount();
      if (species) loadSpecies();
      loadView();
    }, 250);
  }

  // Theme switches recolor the dots and swap the basemap.
  function onTheme() {
    readColors();
    tiles.setUrl(tileUrl());
    restyle();
  }
  darkMq.addEventListener?.('change', onTheme);

  // Theme switch: System (no data-theme), Light or Dark. Saved per browser.
  const themeInputs = [...document.querySelectorAll('input[name="theme"]')];
  const saved = root.dataset.theme === 'light' || root.dataset.theme === 'dark' ? root.dataset.theme : 'system';
  themeInputs.forEach((inp) => {
    inp.checked = inp.value === saved;
    inp.addEventListener('change', () => {
      if (!inp.checked) return;
      if (inp.value === 'system') delete root.dataset.theme;
      else root.dataset.theme = inp.value;
      try {
        if (inp.value === 'system') localStorage.removeItem('theme');
        else localStorage.setItem('theme', inp.value);
      } catch (e) { /* storage unavailable: the choice lasts for this visit */ }
    });
  });
  new MutationObserver(onTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------
  async function init() {
    renderControls();
    let meta;
    try {
      meta = await arcgis('', {});
    } catch (e) {
      $('nlabel').textContent = "Couldn't reach the city's tree data. Try reloading.";
      return;
    }
    state.f = resolveFields(meta.fields || []);
    state.oid = meta.objectIdField || (meta.fields || []).find((f) => f.type === 'esriFieldTypeOID')?.name || 'OBJECTID';
    state.maxRec = meta.maxRecordCount || 2000;
    console.info('[trees] resolved fields', state.f);
    ready = true;

    const base = `${CONFIG.statusField} = ${sql(CONFIG.statusValue)}`;
    const C = state.f.common, S = state.f.scientific, D = state.f.diameter;
    const groupBy = [C, S].filter(Boolean);

    const [groups, largest] = await Promise.all([
      groupBy.length ? queryAll({
        where: base,
        groupByFieldsForStatistics: groupBy.join(','),
        outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: state.oid, outStatisticFieldName: 'n' }]),
        orderByFields: 'n DESC',
      }).catch(() => []) : [],
      D ? query({
        where: `${base} AND ${D} > 0 AND ${D} <= ${CONFIG.maxDiameter}`,
        outFields: outFields(),
        returnGeometry: 'true',
        outSR: '4326',
        orderByFields: `${D} DESC`,
        resultRecordCount: '1',
      }).then((r) => r.features?.[0]).catch(() => null) : null,
    ]);

    // Totals, family counts, and each species' most common scientific name.
    const famCounts = FAMS.map(() => 0);
    const bySpecies = new Map();
    let total = 0;
    for (const ft of groups) {
      const a = ft.attributes;
      const n = Number(attr(a, 'n')) || 0;
      const name = C ? attr(a, C) : null;
      const sci = S ? attr(a, S) : null;
      total += n;
      famCounts[famOfSci(sci)] += n;
      if (name && String(name).trim()) {
        const s = bySpecies.get(name) || { count: 0, best: 0, sci: null };
        s.count += n;
        if (n > s.best) { s.best = n; s.sci = sci; }
        bySpecies.set(name, s);
      }
    }
    for (const [name, s] of bySpecies) speciesInfo.set(name, { sci: s.sci, fam: famOfSci(s.sci) });

    if (groups.length) {
      state.total = state.match = total;
      speciesRows = [...bySpecies].map(([name, s]) => ({ name, count: s.count })).sort((a, b) => b.count - a.count);
    } else {
      loadCount().then(() => { state.total = state.match; renderCount(); });
      loadSpecies();
    }
    if (S) buildChips(famCounts);
    else famsEl.closest('section').hidden = true;
    renderControls();
    renderCount();
    renderList();

    // Open in a useful state: the largest recorded tree, selected.
    if (largest?.geometry) {
      map.setView([largest.geometry.y, largest.geometry.x], CONFIG.detailZoom);
      select(largest);
    } else {
      loadView();
    }
  }

  init();
})();
