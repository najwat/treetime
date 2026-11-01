/* Seattle Street Trees explorer — plain JS, no build step. */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  const CONFIG = {
    layerUrl: 'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/SDOT_Trees_CDL/FeatureServer/0',
    statusField: 'CURRENT_STATUS',
    statusValue: 'INSVC',

    // Field names are looked up against the layer's own metadata at startup.
    // The first candidate that exists wins; if none does, the regex is tried
    // against field names and aliases. Edit these if the layer schema changes.
    fields: {
      common:     { candidates: ['COMMON_NAME', 'COMMONNAME', 'COMMON'], pattern: /common/i },
      scientific: { candidates: ['SCIENTIFIC_NAME', 'SCIENTIFIC', 'BOTANICAL_NAME'], pattern: /scien|botan/i },
      diameter:   { candidates: ['DIAM', 'DBH', 'DIAMETER', 'DSH'], pattern: /diam|dbh/i },
      height:     { candidates: ['TREEHEIGHT', 'TREE_HEIGHT', 'HEIGHT'], pattern: /height/i },
      address:    { candidates: ['UNITDESC', 'ADDRESS', 'LOCATION'], pattern: /addr/i },
      condition:  { candidates: ['CONDITION'], pattern: null },
      planted:    { candidates: ['PLANTED_DATE', 'PLANTDATE'], pattern: /plant.*date/i },
      unitId:     { candidates: ['UNITID'], pattern: null },
    },

    diameterUnit: 'in',
    heightUnit: 'ft',
    sliderCap: 60,          // slider max (inches); the top stop means "this or larger"
    maxPerView: 2000,       // max trees drawn per map view (also capped by the layer)
    center: [47.6062, -122.3321],
    zoom: 13,
  };

  // ---------------------------------------------------------------------------
  // State & DOM
  // ---------------------------------------------------------------------------
  const state = {
    f: {},                  // resolved field names
    domains: {},            // field name -> {code: label}
    objectIdField: 'OBJECTID',
    maxRecordCount: 2000,
    species: [],            // [{name, count}]
    selectedSpecies: null,
    sliderMax: CONFIG.sliderCap,
    openEnded: true,        // top slider stop means "and larger"
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    panel: $('panel'),
    toggle: $('toggle-panel'),
    input: $('species-input'),
    list: $('species-list'),
    clear: $('species-clear'),
    speciesHint: $('species-hint'),
    dMin: $('diam-min'),
    dMax: $('diam-max'),
    dFill: $('diam-fill'),
    dReadout: $('diam-readout'),
    reset: $('reset'),
    countTotal: $('count-total'),
    countView: $('count-view'),
    notice: $('notice'),
  };

  const fmt = new Intl.NumberFormat('en-US');

  // ---------------------------------------------------------------------------
  // ArcGIS REST helpers
  // ---------------------------------------------------------------------------
  async function arcgis(path, params, signal) {
    const qs = new URLSearchParams({ f: 'json', ...params });
    const res = await fetch(`${CONFIG.layerUrl}${path}?${qs}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) {
      throw new Error(data.error.message + (data.error.details?.length ? ` (${data.error.details.join('; ')})` : ''));
    }
    return data;
  }

  const query = (params, signal) => arcgis('/query', params, signal);

  function sqlString(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
  }

  function resolveFields(fields) {
    const byName = new Map(fields.map((f) => [f.name.toUpperCase(), f]));
    const out = {};
    for (const [key, spec] of Object.entries(CONFIG.fields)) {
      let hit = spec.candidates.map((c) => byName.get(c.toUpperCase())).find(Boolean);
      if (!hit && spec.pattern) {
        hit = fields.find((f) => spec.pattern.test(f.name) || spec.pattern.test(f.alias || ''));
      }
      if (hit) out[key] = hit.name;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Where-clause from current filters
  // ---------------------------------------------------------------------------
  function buildWhere() {
    const parts = [`${CONFIG.statusField} = ${sqlString(CONFIG.statusValue)}`];
    const { common, diameter } = state.f;

    if (common && state.selectedSpecies) {
      parts.push(`${common} = ${sqlString(state.selectedSpecies)}`);
    }

    if (diameter) {
      const lo = Number(els.dMin.value);
      const hi = Number(els.dMax.value);
      const hiIsOpen = hi >= state.sliderMax && state.openEnded;
      if (lo > 0) parts.push(`${diameter} >= ${lo}`);
      if (!hiIsOpen) parts.push(`${diameter} <= ${hi}`);
    }
    return parts.join(' AND ');
  }

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------
  const map = L.map('map', { preferCanvas: true, zoomControl: true }).setView(CONFIG.center, CONFIG.zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // Keep Leaflet's size in sync when the panel above/beside the map changes height.
  new ResizeObserver(() => map.invalidateSize()).observe(map.getContainer());

  const renderer = L.canvas({ padding: 0.3 });
  const treeLayer = L.layerGroup().addTo(map);

  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function display(field, value) {
    if (value === null || value === undefined || value === '') return null;
    const dom = state.domains[field];
    if (dom && dom[value] !== undefined) return dom[value];
    return value;
  }

  function popupHtml(a) {
    const f = state.f;
    const get = (k) => (f[k] ? display(f[k], a[f[k]]) : null);
    const common = get('common') || 'Unknown tree';
    const sci = get('scientific');
    const rows = [];
    const diam = get('diameter');
    const height = get('height');
    const planted = get('planted');
    if (diam !== null) rows.push(['Diameter', `${diam} ${CONFIG.diameterUnit}`]);
    if (height !== null && Number(height) > 0) rows.push(['Height', `${height} ${CONFIG.heightUnit}`]);
    if (get('address')) rows.push(['Location', get('address')]);
    if (get('condition')) rows.push(['Condition', get('condition')]);
    if (planted !== null) {
      const d = typeof planted === 'number' ? new Date(planted) : null;
      rows.push(['Planted', d && !isNaN(d) ? d.toLocaleDateString() : planted]);
    }
    if (get('unitId')) rows.push(['Tree ID', get('unitId')]);

    return `<div class="tree-popup">
      <h3>${esc(common)}</h3>
      ${sci && sci !== common ? `<p class="sci">${esc(sci)}</p>` : ''}
      <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    </div>`;
  }

  function radiusFor(a) {
    const d = Number(a[state.f.diameter]);
    if (!d || d < 0) return 4;
    return Math.max(3, Math.min(10, 3 + Math.sqrt(d)));
  }

  // ---------------------------------------------------------------------------
  // Loading data
  // ---------------------------------------------------------------------------
  let totalCtl = null;
  let viewCtl = null;

  function showNotice(msg) {
    els.notice.textContent = msg || '';
    els.notice.hidden = !msg;
  }

  async function loadTotal() {
    totalCtl?.abort();
    totalCtl = new AbortController();
    els.countTotal.textContent = '…';
    try {
      const { count } = await query({ where: buildWhere(), returnCountOnly: 'true' }, totalCtl.signal);
      els.countTotal.textContent = fmt.format(count);
    } catch (e) {
      if (e.name === 'AbortError') return;
      els.countTotal.textContent = '–';
      showNotice(`Couldn't load the tree count: ${e.message}`);
    }
  }

  async function loadView() {
    viewCtl?.abort();
    viewCtl = new AbortController();
    const { signal } = viewCtl;

    const b = map.getBounds();
    const spatial = {
      geometry: JSON.stringify({
        xmin: b.getWest(), ymin: b.getSouth(), xmax: b.getEast(), ymax: b.getNorth(),
        spatialReference: { wkid: 4326 },
      }),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
    };
    const where = buildWhere();
    const limit = Math.min(CONFIG.maxPerView, state.maxRecordCount);
    const outFields = [state.objectIdField, ...new Set(Object.values(state.f))].join(',');

    els.countView.textContent = 'Loading trees in view…';
    try {
      const [countRes, featRes] = await Promise.all([
        query({ where, ...spatial, returnCountOnly: 'true' }, signal),
        query({
          where, ...spatial,
          outFields,
          returnGeometry: 'true',
          outSR: '4326',
          resultRecordCount: String(limit),
        }, signal),
      ]);

      treeLayer.clearLayers();
      for (const feat of featRes.features || []) {
        const g = feat.geometry;
        if (!g || g.x == null || g.y == null) continue;
        L.circleMarker([g.y, g.x], {
          renderer,
          radius: radiusFor(feat.attributes),
          color: '#1f5c38',
          weight: 1,
          fillColor: '#3fa66a',
          fillOpacity: 0.75,
        })
          .bindPopup(() => popupHtml(feat.attributes), { maxWidth: 260 })
          .addTo(treeLayer);
      }

      const inView = countRes.count;
      const shown = (featRes.features || []).length;
      els.countView.textContent = `${fmt.format(inView)} in current map view`;
      if (shown < inView) {
        showNotice(`Showing ${fmt.format(shown)} of ${fmt.format(inView)} trees in view. Zoom in to see them all.`);
      } else {
        showNotice('');
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      els.countView.textContent = '';
      showNotice(`Couldn't load trees for this view: ${e.message}`);
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  const refreshAll = debounce(() => { loadTotal(); loadView(); }, 250);
  map.on('moveend', debounce(loadView, 250));

  // ---------------------------------------------------------------------------
  // Species combobox
  // ---------------------------------------------------------------------------
  let activeIdx = -1;
  let visible = [];

  function renderList() {
    const q = els.input.value.trim().toLowerCase();
    visible = q ? state.species.filter((s) => s.name.toLowerCase().includes(q)) : state.species;
    const items = visible.slice(0, 200);
    activeIdx = Math.min(activeIdx, items.length - 1);
    els.list.innerHTML = items.length
      ? items.map((s, i) =>
          `<li role="option" id="opt-${i}" data-i="${i}" aria-selected="${i === activeIdx}">
             <span>${esc(s.name)}</span><span class="n">${fmt.format(s.count)}</span>
           </li>`).join('')
      : '<li class="empty">No matching tree types</li>';
    els.input.setAttribute('aria-activedescendant', activeIdx >= 0 ? `opt-${activeIdx}` : '');
    els.list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function openList() {
    els.list.hidden = false;
    els.input.setAttribute('aria-expanded', 'true');
    renderList();
  }

  function closeList() {
    els.list.hidden = true;
    els.input.setAttribute('aria-expanded', 'false');
    activeIdx = -1;
  }

  function selectSpecies(name) {
    state.selectedSpecies = name;
    els.input.value = name || '';
    els.clear.hidden = !name;
    const s = state.species.find((x) => x.name === name);
    els.speciesHint.textContent = name ? `${fmt.format(s?.count ?? 0)} in-service trees citywide` : 'All tree types';
    closeList();
    refreshAll();
  }

  els.input.addEventListener('focus', openList);
  els.input.addEventListener('input', () => {
    activeIdx = -1;
    openList();
    if (!els.input.value.trim() && state.selectedSpecies) selectSpecies(null);
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (els.list.hidden) openList();
      activeIdx = Math.min(activeIdx + 1, Math.min(visible.length, 200) - 1);
      renderList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = visible[activeIdx >= 0 ? activeIdx : 0];
      if (pick) selectSpecies(pick.name);
    } else if (e.key === 'Escape') {
      closeList();
      els.input.value = state.selectedSpecies || '';
    }
  });
  els.input.addEventListener('blur', () => {
    // Restore the committed selection if the user typed without choosing.
    setTimeout(() => {
      if (document.activeElement === els.input) return;
      closeList();
      els.input.value = state.selectedSpecies || '';
    }, 0);
  });
  // mousedown keeps focus in the input so the click registers before blur.
  els.list.addEventListener('mousedown', (e) => e.preventDefault());
  els.list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) selectSpecies(visible[Number(li.dataset.i)].name);
  });
  els.clear.addEventListener('click', () => { selectSpecies(null); els.input.focus(); });

  // ---------------------------------------------------------------------------
  // Diameter range slider
  // ---------------------------------------------------------------------------
  function updateRangeUi(changed) {
    let lo = Number(els.dMin.value);
    let hi = Number(els.dMax.value);
    if (lo > hi) {
      if (changed === els.dMin) { els.dMin.value = hi; lo = hi; } else { els.dMax.value = lo; hi = lo; }
    }
    const max = state.sliderMax;
    els.dFill.style.left = `${(lo / max) * 100}%`;
    els.dFill.style.right = `${100 - (hi / max) * 100}%`;
    // Keep the lower thumb reachable when both thumbs sit at the top end.
    els.dMin.style.zIndex = lo >= max - 1 ? 3 : 2;

    const u = CONFIG.diameterUnit;
    const hiOpen = hi >= max && state.openEnded;
    if (lo === 0 && hiOpen) els.dReadout.textContent = 'Any size';
    else if (hiOpen) els.dReadout.textContent = `${lo} ${u} or larger`;
    else if (lo === 0) els.dReadout.textContent = `Up to ${hi} ${u}`;
    else els.dReadout.textContent = `${lo}–${hi} ${u}`;
    els.dMin.setAttribute('aria-valuetext', `${lo} ${u}`);
    els.dMax.setAttribute('aria-valuetext', hiOpen ? `${hi} ${u} or larger` : `${hi} ${u}`);
  }

  for (const el of [els.dMin, els.dMax]) {
    el.addEventListener('input', () => updateRangeUi(el));
    el.addEventListener('change', refreshAll);
  }

  els.reset.addEventListener('click', () => {
    els.dMin.value = 0;
    els.dMax.value = state.sliderMax;
    updateRangeUi();
    selectSpecies(null);
  });

  // Mobile: collapse/expand the filter panel.
  els.toggle.addEventListener('click', () => {
    const collapsed = els.panel.classList.toggle('collapsed');
    els.toggle.setAttribute('aria-expanded', String(!collapsed));
  });

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------
  async function init() {
    let meta;
    try {
      meta = await arcgis('', {});
    } catch (e) {
      els.input.placeholder = 'Unavailable';
      showNotice(`Couldn't reach the SDOT Trees service: ${e.message}`);
      return;
    }

    state.f = resolveFields(meta.fields || []);
    state.objectIdField = meta.objectIdField || (meta.fields || []).find((f) => f.type === 'esriFieldTypeOID')?.name || 'OBJECTID';
    state.maxRecordCount = meta.maxRecordCount || 2000;
    for (const fld of meta.fields || []) {
      if (fld.domain?.type === 'codedValue') {
        state.domains[fld.name] = Object.fromEntries(fld.domain.codedValues.map((c) => [c.code, c.name]));
      }
    }
    console.info('[trees] resolved fields', state.f);

    const base = `${CONFIG.statusField} = ${sqlString(CONFIG.statusValue)}`;
    const tasks = [];

    // Species list: distinct common names with counts, most common first.
    if (state.f.common) {
      tasks.push(query({
        where: `${base} AND ${state.f.common} IS NOT NULL`,
        groupByFieldsForStatistics: state.f.common,
        outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: state.objectIdField, outStatisticFieldName: 'n' }]),
        orderByFields: 'n DESC',
      }).then((r) => {
        state.species = (r.features || [])
          .map((ft) => {
            const a = ft.attributes;
            const key = Object.keys(a).find((k) => k.toUpperCase() === state.f.common.toUpperCase());
            const nKey = Object.keys(a).find((k) => k.toLowerCase() === 'n');
            return { name: a[key], count: a[nKey] };
          })
          .filter((s) => s.name && String(s.name).trim());
        els.input.disabled = false;
        els.input.placeholder = `Search ${fmt.format(state.species.length)} tree types…`;
      }).catch((e) => {
        els.input.placeholder = 'Unavailable';
        showNotice(`Couldn't load tree types: ${e.message}`);
      }));
    } else {
      els.input.placeholder = 'Not available';
      els.speciesHint.textContent = 'No common-name field found on this layer.';
    }

    // Diameter bounds.
    if (state.f.diameter) {
      tasks.push(query({
        where: `${base} AND ${state.f.diameter} > 0`,
        outStatistics: JSON.stringify([{ statisticType: 'max', onStatisticField: state.f.diameter, outStatisticFieldName: 'dmax' }]),
      }).then((r) => {
        const a = r.features?.[0]?.attributes || {};
        const dmax = Number(a.dmax ?? a.DMAX);
        if (dmax > 0) {
          state.sliderMax = Math.max(5, Math.min(Math.ceil(dmax), CONFIG.sliderCap));
        }
      }).catch(() => { /* keep defaults */ }));
    } else {
      els.dMin.disabled = els.dMax.disabled = true;
      els.dReadout.textContent = 'No diameter field found on this layer.';
    }

    await Promise.all(tasks);
    els.dMin.max = els.dMax.max = state.sliderMax;
    els.dMax.value = state.sliderMax;
    updateRangeUi();
    loadTotal();
    loadView();
  }

  updateRangeUi();
  init();
})();
