/**
 * Client de l'API découpage administratif (geo.api.gouv.fr) : recherche de communes et contour.
 * Toutes les erreurs sont relayées en français, prêtes à être affichées par le panneau « Ville ».
 */
import type { CommuneDetail, CommuneSummary } from './types'

const API_BASE = 'https://geo.api.gouv.fr'
const FIELDS = 'nom,code,codesPostaux,centre,population,surface'
const LIMIT = 10

/** Erreur applicative dont le message est destiné à l'utilisateur (déjà en français). */
export class GeoApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'GeoApiError'
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  } catch (err) {
    if (isAbort(err)) throw err
    throw new GeoApiError('Impossible de joindre geo.api.gouv.fr : vérifiez votre connexion réseau.')
  }
  if (!res.ok) {
    if (res.status === 404) throw new GeoApiError('Commune introuvable sur geo.api.gouv.fr.', 404)
    if (res.status === 429) {
      throw new GeoApiError('geo.api.gouv.fr : trop de requêtes, réessayez dans quelques instants.', 429)
    }
    if (res.status >= 500) {
      throw new GeoApiError(`geo.api.gouv.fr est indisponible (erreur ${res.status}) : réessayez plus tard.`, res.status)
    }
    throw new GeoApiError(`geo.api.gouv.fr a refusé la requête (erreur ${res.status}).`, res.status)
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new GeoApiError('Réponse illisible de geo.api.gouv.fr.')
  }
}

/**
 * Recherche de communes par nom ou par code postal.
 *  - exactement 5 chiffres → recherche par code postal (plusieurs communes peuvent le partager, toutes sont renvoyées) ;
 *  - 1 à 4 chiffres → aucune requête (l'interface invite à saisir les 5 chiffres) ;
 *  - sinon → recherche par nom.
 * Résultats triés par population décroissante.
 */
export async function searchCommunes(query: string, signal?: AbortSignal): Promise<CommuneSummary[]> {
  const q = query.trim()
  if (!q) return []
  let param: string
  if (/^\d{5}$/.test(q)) param = `codePostal=${q}`
  else if (/^\d{1,4}$/.test(q)) return []
  else param = `nom=${encodeURIComponent(q)}`

  const url = `${API_BASE}/communes?${param}&fields=${FIELDS}&boost=population&limit=${LIMIT}&format=json`
  const list = await getJson<CommuneSummary[]>(url, signal)
  if (!Array.isArray(list)) return []
  return [...list].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
}

/** Détail d'une commune avec son contour administratif (GeoJSON, lon/lat). */
export async function fetchCommune(code: string, signal?: AbortSignal): Promise<CommuneDetail> {
  const url = `${API_BASE}/communes/${encodeURIComponent(code)}?fields=${FIELDS},contour&format=json`
  const commune = await getJson<CommuneDetail>(url, signal)
  if (!commune?.contour?.coordinates?.length) {
    throw new GeoApiError(`Le contour de la commune ${code} est absent de geo.api.gouv.fr.`)
  }
  if (!commune.centre?.coordinates) {
    throw new GeoApiError(`Le centre de la commune ${code} est absent de geo.api.gouv.fr.`)
  }
  return commune
}
