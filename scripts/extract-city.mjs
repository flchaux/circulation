#!/usr/bin/env node
// Pré-extraction d'une commune française : métadonnées geo.api.gouv.fr + réseau routier OSM (Overpass).
// Usage : node scripts/extract-city.mjs <code INSEE> [slug]
// Produit public/demo/<slug>.osm.json consommé par l'application (même pipeline que le chargement en ligne).

const code = process.argv[2] ?? '42323'
const slugArg = process.argv[3]

const HIGHWAY_RE = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$'
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
]

function slugify(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

// Douglas-Peucker sur un anneau [lon,lat]
function simplify(ring, tol) {
  if (ring.length <= 4) return ring
  const sqTol = tol * tol
  const sqSegDist = (p, a, b) => {
    let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
      if (t > 1) { x = b[0]; y = b[1] } else if (t > 0) { x += dx * t; y += dy * t }
    }
    dx = p[0] - x; dy = p[1] - y
    return dx * dx + dy * dy
  }
  const keep = new Uint8Array(ring.length)
  keep[0] = 1; keep[ring.length - 1] = 1
  const stack = [[0, ring.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()
    let maxD = 0, idx = -1
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(ring[i], ring[first], ring[last])
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > sqTol && idx > 0) { keep[idx] = 1; stack.push([first, idx], [idx, last]) }
  }
  return ring.filter((_, i) => keep[i])
}

function outerRings(contour) {
  if (contour.type === 'Polygon') return [contour.coordinates[0]]
  if (contour.type === 'MultiPolygon') return contour.coordinates.map(p => p[0])
  throw new Error('Type de contour inattendu : ' + contour.type)
}

async function fetchJson(url, init) {
  const r = await fetch(url, init)
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  return r.json()
}

async function overpass(query) {
  let lastErr
  for (const url of MIRRORS) {
    try {
      const t0 = Date.now()
      const json = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'circulation-simulateur/0.1 (extraction de démonstration)' },
        body: 'data=' + encodeURIComponent(query),
      })
      console.error(`Overpass OK via ${url} en ${((Date.now() - t0) / 1000).toFixed(1)} s`)
      return json
    } catch (e) {
      lastErr = e
      console.error(`Échec ${url} : ${e.message}`)
    }
  }
  throw lastErr
}

const commune = await fetchJson(`https://geo.api.gouv.fr/communes/${code}?fields=nom,code,codesPostaux,centre,population,surface,contour&format=json`)
console.error(`Commune : ${commune.nom} (${commune.code}), ${commune.population} hab., ${(commune.surface / 100).toFixed(1)} km²`)

const rings = outerRings(commune.contour).map(r => simplify(r, 0.00015))
const polyFilters = rings.map(r => `(poly:"${r.map(([lon, lat]) => `${lat.toFixed(5)} ${lon.toFixed(5)}`).join(' ')}")`)
const query = `[out:json][timeout:180];
(
${polyFilters.map(p => `  way["highway"~"${HIGHWAY_RE}"]${p};`).join('\n')}
)->.w;
(
  .w;
  .w >;
  rel(bw.w)["type"="restriction"];
);
out body qt;`

const osm = await overpass(query)
const counts = { node: 0, way: 0, relation: 0, signals: 0 }
for (const el of osm.elements) {
  counts[el.type]++
  if (el.type === 'node' && el.tags?.highway === 'traffic_signals') counts.signals++
}
console.error(`Éléments : ${counts.way} ways, ${counts.node} nodes (${counts.signals} feux), ${counts.relation} relations de restriction`)

const slug = slugArg ?? slugify(commune.nom)
const out = {
  format: 'circulation-osm-extract',
  version: 1,
  extractedAt: new Date().toISOString(),
  attribution: '© les contributeurs OpenStreetMap (ODbL) ; contours et communes : geo.api.gouv.fr (Etalab)',
  commune: { nom: commune.nom, code: commune.code, codesPostaux: commune.codesPostaux, centre: commune.centre, population: commune.population, surface: commune.surface, contour: commune.contour },
  osm,
}
const fs = await import('node:fs/promises')
const path = `public/demo/${slug}.osm.json`
await fs.mkdir('public/demo', { recursive: true })
await fs.writeFile(path, JSON.stringify(out))
const stat = await fs.stat(path)
console.error(`Écrit ${path} (${(stat.size / 1024).toFixed(0)} Ko)`)
