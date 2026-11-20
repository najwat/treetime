// Small helpers for ArcGIS REST feature layers. Sources built on these never leak
// ArcGIS shapes to the rest of the app.

export const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

export async function arcgisQuery(layerUrl, params, { signal, fetchImpl = fetch } = {}) {
  const qs = new URLSearchParams({ f: 'json', ...params });
  const url = `${layerUrl}/query`;
  // Long where clauses go as a form POST (a "simple" CORS request, no preflight).
  const res = qs.toString().length > 1800
    ? await fetchImpl(url, { method: 'POST', body: qs, signal })
    : await fetchImpl(`${url}?${qs}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Query failed');
  return data;
}

// Every page of a query. The layers cap a normal page at 2,000 records (8,000 with
// resultType=tile) and say so with exceededTransferLimit; keep going until they don't.
export async function arcgisQueryAll(layerUrl, params, { signal, fetchImpl, cap = Infinity } = {}) {
  const out = [];
  for (;;) {
    const page = out.length ? { ...params, resultOffset: String(out.length) } : params;
    const r = await arcgisQuery(layerUrl, page, { signal, fetchImpl });
    const feats = r.features || [];
    out.push(...feats);
    if (!r.exceededTransferLimit || !feats.length || out.length >= cap) return out;
  }
}

export function envelope(bbox) {
  const [w, s, e, n] = bbox;
  return {
    geometry: `${w},${s},${e},${n}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
  };
}

// Case-insensitive attribute read (statistics queries may change the case of names).
export function attr(a, name) {
  if (!a || !name) return undefined;
  if (name in a) return a[name];
  const k = Object.keys(a).find((x) => x.toUpperCase() === name.toUpperCase());
  return k ? a[k] : undefined;
}

// Slippy-map tile maths (the data is loaded in z14 tiles and cached per tile).
export function tileBBox(z, x, y) {
  const n = 2 ** z;
  const lng = (X) => (X / n) * 360 - 180;
  const lat = (Y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / n))) * 180) / Math.PI;
  return [lng(x), lat(y + 1), lng(x + 1), lat(y)];
}
export function tileOf(lng, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}
export function tilesForBBox([w, s, e, n], z) {
  const [x0, y0] = tileOf(w, n, z), [x1, y1] = tileOf(e, s, z);
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  return out;
}
