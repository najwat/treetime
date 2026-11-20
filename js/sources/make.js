// Builds a TreeTime source from an ArcGIS feature layer and a description of its
// fields. A source answers the app's questions in TreeTime terms only:
//
//   count(filters, {bbox})          how many active trees match
//   trees(filters, {bbox, limit})   matching trees (server-filtered; for zoomed-out views)
//   tile(z, x, y)                   every active tree in a map tile (filtered client-side)
//   species(filters, {bbox, limit}) [{common, scientific, count}], most common first
//   byIds(sourceIds)                the active trees with those ids (saved-tree check)
//   largest()                       the active tree with the largest plausible trunk
//   normalize(feature)              raw record -> tree (or null)
//
// Other cities or non-ArcGIS sources only need to provide the same methods.
import { arcgisQuery, arcgisQueryAll, attr, envelope, sqlString, tileBBox } from './arcgis.js';
import { FAMILIES, KNOWN_GENERA, MAX_DIAMETER_IN, OTHER_FAMILY, makeTree, sizeActive } from '../tree.js';

export function createArcgisSource(cfg) {
  const F = cfg.fields;
  const fetchOpts = (signal) => ({ signal, fetchImpl: cfg.fetchImpl });
  const outFields = [...new Set([F.oid, F.id, F.common, F.scientific, F.diameter, F.height, F.planted, F.place, F.heritage].filter(Boolean))].join(',');
  const idSql = (id) => (cfg.numericId ? String(Number(id)) : sqlString(id));

  const genusClause = (g) => `${F.scientific} = ${sqlString(g)} OR ${F.scientific} LIKE ${sqlString(`${g} %`)}`;
  function familyClause(id) {
    if (id !== OTHER_FAMILY) return `(${FAMILIES.find((f) => f.id === id).genera.map(genusClause).join(' OR ')})`;
    return `(${F.scientific} IS NULL OR NOT (${KNOWN_GENERA.map(genusClause).join(' OR ')}))`;
  }

  // The same rules as tree.js matches(), as a where clause for this layer.
  function where(filters = {}, { species = true } = {}) {
    const p = [cfg.activeWhere];
    if (filters.families && filters.families.size < FAMILIES.length) {
      p.push(filters.families.size ? `(${[...filters.families].map(familyClause).join(' OR ')})` : '1=0');
    }
    if (sizeActive(filters)) {
      p.push(`${F.diameter} > 0`, `${F.diameter} <= ${MAX_DIAMETER_IN}`);
      if (filters.dmin > 0) p.push(`${F.diameter} >= ${Number(filters.dmin)}`);
      if (filters.dmax != null) p.push(`${F.diameter} < ${Number(filters.dmax) + 1}`);
    }
    if (species && filters.species) p.push(`UPPER(${F.common}) = ${sqlString(String(filters.species).toUpperCase())}`);
    return p.join(' AND ');
  }

  function normalize(feature, now) {
    const a = feature && feature.attributes;
    const g = feature && feature.geometry;
    if (!a || !g) return null;
    return makeTree({
      source: cfg.id,
      sourceId: attr(a, F.id),
      common: attr(a, F.common),
      scientific: attr(a, F.scientific),
      diameter: attr(a, F.diameter),
      height: F.height ? attr(a, F.height) : null,
      plantedMs: F.planted ? attr(a, F.planted) : null,
      place: F.place ? attr(a, F.place) : null,
      placeKind: cfg.placeKind,
      heritage: F.heritage ? String(attr(a, F.heritage) || '').toUpperCase() === 'Y' : false,
      lat: g.y, lng: g.x,
      now,
    });
  }
  const toTrees = (features) => features.map((f) => normalize(f)).filter(Boolean);
  const geo = { returnGeometry: 'true', outSR: '4326', geometryPrecision: '6' };
  const countStat = JSON.stringify([{ statisticType: 'count', onStatisticField: F.oid, outStatisticFieldName: 'n' }]);

  return {
    id: cfg.id,
    label: cfg.label,
    shortLabel: cfg.shortLabel,
    noun: cfg.noun,
    cardLabel: cfg.cardLabel,
    inventoryName: cfg.inventoryName,
    publisher: cfg.publisher,
    credit: cfg.credit,
    covers: cfg.covers,
    refresh: cfg.refresh,
    infoUrl: cfg.infoUrl,
    layerUrl: cfg.url,
    where,
    normalize,

    async count(filters, { bbox, signal } = {}) {
      const r = await arcgisQuery(cfg.url, { where: where(filters), ...(bbox ? envelope(bbox) : {}), returnCountOnly: 'true' }, fetchOpts(signal));
      return r.count || 0;
    },

    async trees(filters, { bbox, limit = 3000, signal } = {}) {
      const feats = await arcgisQueryAll(cfg.url, {
        where: where(filters), ...(bbox ? envelope(bbox) : {}), outFields, ...geo, orderByFields: F.oid, resultRecordCount: '2000',
      }, { ...fetchOpts(signal), cap: limit });
      return toTrees(feats);
    },

    async tile(z, x, y, { signal } = {}) {
      const feats = await arcgisQueryAll(cfg.url, {
        where: cfg.activeWhere, ...envelope(tileBBox(z, x, y)), outFields, ...geo, orderByFields: F.oid, resultType: 'tile',
      }, fetchOpts(signal));
      // A tree exactly on a tile edge is returned by both tiles; keep it in the one that contains it.
      const [w, s, e, n] = tileBBox(z, x, y);
      return toTrees(feats).filter((t) => t.lng >= w && t.lng < e && t.lat > s && t.lat <= n);
    },

    async species(filters, { bbox, limit, withScientific = false, signal } = {}) {
      const by = withScientific ? `${F.common},${F.scientific}` : F.common;
      const params = {
        where: `${where(filters, { species: false })}${withScientific ? '' : ` AND ${F.common} IS NOT NULL`}`,
        ...(bbox ? envelope(bbox) : {}),
        groupByFieldsForStatistics: by, outStatistics: countStat, orderByFields: 'n DESC',
      };
      const feats = limit
        ? ((await arcgisQuery(cfg.url, { ...params, resultRecordCount: String(limit) }, fetchOpts(signal))).features || [])
        : await arcgisQueryAll(cfg.url, params, fetchOpts(signal));
      return feats.map((f) => ({
        common: attr(f.attributes, F.common),
        scientific: withScientific ? attr(f.attributes, F.scientific) : undefined,
        count: Number(attr(f.attributes, 'n')) || 0,
      }));
    },

    async byIds(sourceIds, { signal } = {}) {
      const ids = [...new Set(sourceIds.map(String))].filter((id) => (cfg.numericId ? /^\d+$/.test(id) : id));
      const out = [];
      for (let k = 0; k < ids.length; k += 100) {
        const chunk = ids.slice(k, k + 100);
        const feats = await arcgisQueryAll(cfg.url, {
          where: `${cfg.activeWhere} AND ${F.id} IN (${chunk.map(idSql).join(',')})`, outFields, ...geo, orderByFields: F.oid,
        }, fetchOpts(signal));
        out.push(...toTrees(feats));
      }
      return out;
    },

    async largest({ signal } = {}) {
      const r = await arcgisQuery(cfg.url, {
        where: `${cfg.activeWhere} AND ${F.diameter} > 0 AND ${F.diameter} <= ${MAX_DIAMETER_IN}`,
        outFields, ...geo, orderByFields: `${F.diameter} DESC, ${F.oid} ASC`, resultRecordCount: '1',
      }, fetchOpts(signal));
      return toTrees(r.features || [])[0] || null;
    },
  };
}
