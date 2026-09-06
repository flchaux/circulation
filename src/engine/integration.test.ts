/**
 * Intégration sur un réseau réel : l'extrait de démonstration de Veauche (42323) est converti en graphe
 * par `osm2graph` (lot A) puis simulé. Le test vérifie les invariants du moteur sur une topologie
 * complète (impasses, giratoires, sens uniques, restrictions) plutôt que des valeurs numériques.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { OsmExtract } from '@/geo/types'
import { osm2graph } from '@/geo/osm2graph'
import { defaultDemand, DEFAULT_SETTINGS } from '@/model/defaults'
import { VEHICLE_STRIDE } from './protocol'
import { generateArrivals } from './demand'
import { Simulation } from './simulation'

const extract = JSON.parse(readFileSync('public/demo/veauche.osm.json', 'utf8')) as OsmExtract
const { network } = osm2graph(extract)
const settings = { ...DEFAULT_SETTINGS, durationMin: 10, warmupMin: 2, statsIntervalMin: 5 }

describe('simulation sur la démo Veauche', () => {
  it('conserve les véhicules et produit des résultats complets', () => {
    const demand = defaultDemand(network, 2026)
    const sim = new Simulation({ network, demand, settings })
    expect(sim.edgeIndex.length).toBeGreaterThan(800)
    let guard = 5000
    while (!sim.done && guard-- > 0) sim.step(50)
    expect(sim.done).toBe(true)

    const r = sim.results()
    expect(r.network.entered).toBe(r.network.exited + r.network.inCirculation)
    expect(generateArrivals(network, demand, settings).length).toBe(r.network.entered + r.network.notInjected)
    expect(r.network.exited).toBeGreaterThan(300)
    expect(Object.keys(r.edges).length).toBe(sim.edgeIndex.length)
    expect(Object.keys(r.exits).length).toBeGreaterThan(5)
    expect(Object.keys(r.intersections).length).toBeGreaterThan(20)
    expect(r.series.times.length).toBeGreaterThan(1)
    for (const stats of Object.values(r.edges)) {
      expect(Number.isFinite(stats.flowVehH)).toBe(true)
      expect(Number.isFinite(stats.meanSpeedKmh)).toBe(true)
      expect(stats.meanQueue).toBeGreaterThanOrEqual(0)
    }
  })

  it('est déterministe et ne place aucun véhicule hors de son tronçon', () => {
    const demand = defaultDemand(network, 7)
    const run = () => {
      const sim = new Simulation({ network, demand, settings: { ...settings, durationMin: 5, warmupMin: 0 } })
      let guard = 5000
      while (!sim.done && guard-- > 0) {
        sim.step(60)
        const frame = sim.frame()
        for (let i = 0; i < frame.vehicles.length; i += VEHICLE_STRIDE) {
          const pos = frame.vehicles[i + 2]
          expect(pos).toBeGreaterThanOrEqual(0)
          expect(pos).toBeLessThanOrEqual(sim.edgeAt(frame.vehicles[i + 1]).length + 1e-6)
        }
      }
      return JSON.stringify(sim.results())
    }
    expect(run()).toBe(run())
  })
})
