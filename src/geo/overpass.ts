/**
 * Client Overpass : télécharge le réseau routier d'une commune à partir de son contour.
 * Même requête que `scripts/extract-city.mjs` afin que l'extrait de démonstration et le
 * téléchargement en ligne produisent exactement le même graphe.
 *
 * Ce module ne touche pas à IndexedDB : la mise en cache (`osm:<code>`) est assurée par
 * `src/state/persistence.ts`, qui interroge le cache avant d'appeler `fetchOsmExtract`.
 */
import type { GeoMultiPolygon, GeoPolygon } from '@/model/types'
import { HIGHWAY_CLASSES } from '@/model/types'
import { ATTRIBUTION } from '@/model/defaults'
import type { CommuneDetail, OsmExtract, OsmJson } from './types'

/** Miroirs interrogés dans l'ordre ; on passe au suivant à la première erreur. */
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
]

/** Délai maximal d'une requête Overpass (identique au `[timeout:180]` de la requête). */
export const OVERPASS_TIMEOUT_MS = 180_000

/**
 * Délai d'attente du premier octet, par miroir. Overpass met parfois plusieurs minutes à *calculer*
 * une requête, mais il envoie ses en-têtes tout de suite : un miroir qui n'a rien renvoyé au bout de
 * ce délai est injoignable, et attendre le budget complet immobiliserait l'utilisateur trois minutes
 * par miroir avant même d'essayer le suivant.
 */
export const OVERPASS_FIRST_BYTE_MS = 20_000

/**
 * Identification de l'application, exigée par la politique d'usage d'Overpass : sans elle les miroirs
 * répondent 406. Les navigateurs ignorent cet en-tête (nom réservé) sans déclencher de pré-vol CORS ;
 * il n'est donc utile qu'aux exécutions hors navigateur (scripts, tests d'intégration).
 */
const USER_AGENT = 'circulation-simulateur/0.1 (simulation de circulation communale)'

/** Tolérance du Douglas-Peucker appliqué au contour avant d'en faire un filtre `poly:` (degrés). */
export const CONTOUR_SIMPLIFY_TOLERANCE = 1.5e-4

export class OverpassError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'OverpassError'
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

/** Distance au carré d'un point au segment [a, b]. */
function sqSegDist(p: [number, number], a: [number, number], b: [number, number]): number {
  let x = a[0]
  let y = a[1]
  let dx = b[0] - x
  let dy = b[1] - y
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) {
      x = b[0]
      y = b[1]
    } else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }
  dx = p[0] - x
  dy = p[1] - y
  return dx * dx + dy * dy
}

/** Simplification Douglas-Peucker d'un anneau [lon, lat] (itérative, sans récursion). */
export function simplifyRing(ring: [number, number][], tolerance = CONTOUR_SIMPLIFY_TOLERANCE): [number, number][] {
  if (ring.length <= 4) return ring
  const sqTol = tolerance * tolerance
  const keep = new Uint8Array(ring.length)
  keep[0] = 1
  keep[ring.length - 1] = 1
  const stack: [number, number][] = [[0, ring.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop() as [number, number]
    let maxD = 0
    let idx = -1
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(ring[i], ring[first], ring[last])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > sqTol && idx > 0) {
      keep[idx] = 1
      stack.push([first, idx], [idx, last])
    }
  }
  return ring.filter((_, i) => keep[i] === 1)
}

/** Anneaux extérieurs du contour (un filtre `poly:` par anneau). */
export function outerRings(contour: GeoPolygon | GeoMultiPolygon): [number, number][][] {
  if (contour.type === 'Polygon') return [contour.coordinates[0]]
  return contour.coordinates.map((polygon) => polygon[0])
}

/** Requête Overpass QL : ways routiers dans le contour, leurs nœuds et les relations de restriction. */
export function buildOverpassQuery(contour: GeoPolygon | GeoMultiPolygon): string {
  const highwayRe = `^(${HIGHWAY_CLASSES.join('|')})$`
  const filters = outerRings(contour)
    .map((ring) => simplifyRing(ring))
    .map((ring) => `(poly:"${ring.map(([lon, lat]) => `${lat.toFixed(5)} ${lon.toFixed(5)}`).join(' ')}")`)
  return `[out:json][timeout:180];
(
${filters.map((p) => `  way["highway"~"${highwayRe}"]${p};`).join('\n')}
)->.w;
(
  .w;
  .w >;
  rel(bw.w)["type"="restriction"];
);
out body qt;`
}

function mirrorLabel(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

async function postQuery(url: string, query: string, signal: AbortSignal | undefined): Promise<OsmJson> {
  const controller = new AbortController()
  let timedOut = false
  let firstByteTimedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, OVERPASS_TIMEOUT_MS)
  // Chien de garde du premier octet : levé dès que les en-têtes arrivent, le budget complet prenant alors le relais.
  const firstByteTimer = setTimeout(() => {
    firstByteTimedOut = true
    controller.abort()
  }, OVERPASS_FIRST_BYTE_MS)
  const relay = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', relay, { once: true })
  }

  try {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      })
      clearTimeout(firstByteTimer)
    } catch (err) {
      if (signal?.aborted) throw err
      if (firstByteTimedOut) {
        throw new OverpassError(
          `Le serveur ${mirrorLabel(url)} ne répond pas (aucune réponse en ${Math.round(OVERPASS_FIRST_BYTE_MS / 1000)} s).`,
        )
      }
      if (timedOut) {
        throw new OverpassError(
          `Le serveur ${mirrorLabel(url)} n'a pas répondu en moins de 3 minutes (délai dépassé).`,
        )
      }
      if (isAbort(err)) throw err
      throw new OverpassError(`Impossible de joindre ${mirrorLabel(url)} : vérifiez votre connexion réseau.`)
    }
    if (!res.ok) {
      if (res.status === 429) {
        throw new OverpassError(
          `Le serveur ${mirrorLabel(url)} est saturé (trop de requêtes simultanées) : réessayez dans quelques minutes.`,
          429,
        )
      }
      if (res.status === 504) {
        throw new OverpassError(
          `Le serveur ${mirrorLabel(url)} a dépassé son temps de calcul (504) : réessayez plus tard.`,
          504,
        )
      }
      throw new OverpassError(`Le serveur ${mirrorLabel(url)} a répondu ${res.status}.`, res.status)
    }
    try {
      return (await res.json()) as OsmJson
    } catch {
      throw new OverpassError(`Réponse illisible du serveur ${mirrorLabel(url)}.`)
    }
  } finally {
    clearTimeout(timer)
    clearTimeout(firstByteTimer)
    signal?.removeEventListener('abort', relay)
  }
}

/**
 * Télécharge l'extrait OSM d'une commune. Les miroirs sont essayés dans l'ordre ;
 * une annulation par `signal` interrompt immédiatement sans essayer le miroir suivant.
 */
export async function fetchOsmExtract(
  commune: CommuneDetail,
  opts?: { signal?: AbortSignal; onProgress?: (message: string) => void },
): Promise<OsmExtract> {
  const { signal, onProgress } = opts ?? {}
  if (!commune.contour?.coordinates?.length) {
    throw new OverpassError(`Le contour de ${commune.nom} est absent : impossible d'interroger Overpass.`)
  }
  const query = buildOverpassQuery(commune.contour)

  let lastError: unknown
  // Un échec par miroir : le message final les énumère tous, sinon seule la dernière cause serait affichée.
  const echecs: string[] = []
  for (const url of OVERPASS_MIRRORS) {
    if (signal?.aborted) break
    onProgress?.(`Téléchargement du réseau routier depuis ${mirrorLabel(url)}…`)
    try {
      const osm = await postQuery(url, query, signal)
      const count = osm.elements?.length ?? 0
      onProgress?.(`Réseau reçu (${count.toLocaleString('fr-FR')} éléments OSM).`)
      return {
        format: 'circulation-osm-extract',
        version: 1,
        extractedAt: new Date().toISOString(),
        attribution: ATTRIBUTION,
        commune,
        osm,
      }
    } catch (err) {
      if (isAbort(err) || signal?.aborted) throw err
      lastError = err
      const message = err instanceof Error ? err.message : `Échec de ${mirrorLabel(url)}.`
      echecs.push(message)
      onProgress?.(message)
    }
  }
  if (signal?.aborted) throw new OverpassError('Téléchargement annulé.')
  if (echecs.length) {
    throw new OverpassError(
      `Aucun serveur OpenStreetMap n'a pu fournir le réseau de ${commune.nom}. ${echecs.join(' ')}`,
      lastError instanceof OverpassError ? lastError.status : undefined,
    )
  }
  throw new OverpassError(
    `Aucun serveur Overpass n'a pu fournir le réseau de ${commune.nom}. Réessayez dans quelques minutes.`,
  )
}
