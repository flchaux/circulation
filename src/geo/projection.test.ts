import { describe, expect, it } from 'vitest'
import { EARTH_RADIUS_M, createProjection } from './projection'

/** Centre de Veauche (42323), commune de démonstration. */
const CENTRE = { lon: 4.29, lat: 45.5616 }

const METERS_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180

/** Distance orthodromique de référence (m), pour contrôler l'erreur de la projection plane. */
function haversine(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s))
}

describe('createProjection', () => {
  it('place l’origine du repère au centre fourni', () => {
    const p = createProjection(CENTRE)
    expect(p.center).toEqual(CENTRE)
    expect(p.toLocal(CENTRE.lon, CENTRE.lat)).toEqual([0, 0])
    expect(p.toLonLat(0, 0)).toEqual(CENTRE)
  })

  it('oriente x vers l’est et y vers le nord', () => {
    const p = createProjection(CENTRE)
    const [xEst, yEst] = p.toLocal(CENTRE.lon + 0.01, CENTRE.lat)
    expect(xEst).toBeGreaterThan(0)
    expect(yEst).toBe(0)

    const [xNord, yNord] = p.toLocal(CENTRE.lon, CENTRE.lat + 0.01)
    expect(xNord).toBe(0)
    expect(yNord).toBeGreaterThan(0)
  })

  it('applique l’échelle R·π/180 en latitude et cos(lat₀) en longitude', () => {
    const p = createProjection(CENTRE)
    const [, y] = p.toLocal(CENTRE.lon, CENTRE.lat + 1)
    expect(y).toBeCloseTo(METERS_PER_DEGREE, 1)

    const [x] = p.toLocal(CENTRE.lon + 1, CENTRE.lat)
    expect(x).toBeCloseTo(METERS_PER_DEGREE * Math.cos((CENTRE.lat * Math.PI) / 180), 1)
  })

  it('arrondit les mètres locaux au centimètre', () => {
    const p = createProjection(CENTRE)
    for (const [dLon, dLat] of [
      [1e-7, 3e-7],
      [1.23456e-4, -5.6789e-4],
      [-0.0123456, 0.0098765],
    ]) {
      const [x, y] = p.toLocal(CENTRE.lon + dLon, CENTRE.lat + dLat)
      expect(x).toBe(Math.round(x * 100) / 100)
      expect(y).toBe(Math.round(y * 100) / 100)
    }
  })

  it('fait l’aller-retour mètres → degrés → mètres au centimètre près', () => {
    const p = createProjection(CENTRE)
    for (const [x0, y0] of [
      [0, 0],
      [1234.56, -987.65],
      [-5000, 5000],
      [12345.67, 8901.23],
    ]) {
      const { lon, lat } = p.toLonLat(x0, y0)
      const [x, y] = p.toLocal(lon, lat)
      expect(x).toBeCloseTo(x0, 2)
      expect(y).toBeCloseTo(y0, 2)
    }
  })

  it('reste fidèle aux distances réelles sur l’emprise d’une commune', () => {
    const p = createProjection(CENTRE)
    // Une commune française tient largement dans un carré de 10 km de côté.
    for (const [dLon, dLat] of [
      [0.05, 0],
      [0, 0.05],
      [0.04, -0.03],
      [-0.06, 0.06],
    ]) {
      const other = { lon: CENTRE.lon + dLon, lat: CENTRE.lat + dLat }
      const [x, y] = p.toLocal(other.lon, other.lat)
      const plane = Math.hypot(x, y)
      const reference = haversine(CENTRE, other)
      // Erreur relative inférieure à 0,1 % (soit moins de 10 cm sur 100 m).
      expect(Math.abs(plane - reference) / reference).toBeLessThan(1e-3)
    }
  })

  it('supporte une origine à l’équateur et une longitude négative', () => {
    const p = createProjection({ lon: -1.5, lat: 0 })
    const [x] = p.toLocal(-0.5, 0)
    expect(x).toBeCloseTo(METERS_PER_DEGREE, 1)
    // L'arrondi au centimètre limite la fidélité du retour en degrés (1 cm ≈ 9·10⁻⁸ °).
    expect(p.toLonLat(x, 0).lon).toBeCloseTo(-0.5, 6)
  })
})
