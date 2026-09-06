/**
 * Projection locale équirectangulaire (« plate carrée » centrée) : WGS84 ↔ mètres locaux.
 *
 * Le repère local a son origine au centre de la commune, x vers l'est et y vers le nord.
 * L'échelle en longitude est figée à la latitude d'origine : sur l'emprise d'une commune
 * française (quelques kilomètres) l'erreur reste très inférieure au décimètre, pour un coût
 * d'une multiplication par coordonnée — indispensable puisque la conversion est appelée
 * à chaque redessin de la carte.
 */

export const EARTH_RADIUS_M = 6371008.8

const DEG_TO_RAD = Math.PI / 180

export interface LocalProjection {
  center: { lon: number; lat: number }
  /** Degrés → mètres locaux, arrondis au centimètre. */
  toLocal(lon: number, lat: number): [number, number]
  /** Mètres locaux → degrés. */
  toLonLat(x: number, y: number): { lon: number; lat: number }
}

export function createProjection(center: { lon: number; lat: number }): LocalProjection {
  const lon0 = center.lon
  const lat0 = center.lat
  /** Mètres par degré de latitude. */
  const metersPerLat = EARTH_RADIUS_M * DEG_TO_RAD
  /** Mètres par degré de longitude à la latitude d'origine. */
  const metersPerLon = Math.cos(lat0 * DEG_TO_RAD) * metersPerLat
  // Garde-fou pour les pôles (jamais atteint pour une commune française) : évite une division par zéro.
  const metersPerLonSafe = Math.abs(metersPerLon) < 1e-9 ? 1e-9 : metersPerLon

  return {
    center: { lon: lon0, lat: lat0 },
    toLocal(lon: number, lat: number): [number, number] {
      return [
        Math.round((lon - lon0) * metersPerLon * 100) / 100,
        Math.round((lat - lat0) * metersPerLat * 100) / 100,
      ]
    },
    toLonLat(x: number, y: number): { lon: number; lat: number } {
      return { lon: lon0 + x / metersPerLonSafe, lat: lat0 + y / metersPerLat }
    },
  }
}
