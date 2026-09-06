import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { osm2graph } from '@/geo/osm2graph'
import { Simulation } from '@/engine/simulation'
import { generateArrivals } from '@/engine/demand'
import { defaultDemand, DEFAULT_SETTINGS, effectiveControl } from '@/model/defaults'
import { createDefaultSignalPlan } from '@/model/signals'
import { buildAdjacency } from '@/model/geometry'
import type { OsmExtract } from '@/geo/types'
import type { Network, NodeId } from '@/model/types'

function charger(): Network {
  const extract = JSON.parse(readFileSync('public/demo/veauche.osm.json', 'utf8')) as OsmExtract
  return osm2graph(extract).network
}

function executer(network: Network, facteur: number, dureeMin = 20) {
  const demand = { ...defaultDemand(network, 7), globalFactor: facteur }
  const settings = { ...DEFAULT_SETTINGS, durationMin: dureeMin, warmupMin: 5 }
  const sim = new Simulation({ network, demand, settings })
  while (!sim.done) sim.step(600)
  return sim.results()
}

/** Carrefour interne le plus fréquenté après une première exécution. */
function carrefourPrincipal(network: Network, results: ReturnType<typeof executer>): NodeId {
  const adj = buildAdjacency(network)
  let best: NodeId = ''
  let bestFlow = -1
  for (const [nodeId, node] of Object.entries(network.nodes)) {
    if (node.boundary) continue
    const ins = adj.incoming.get(nodeId) ?? []
    if (ins.length < 3) continue
    let flow = 0
    for (const e of ins) flow += results.edges[e.id]?.exited ?? 0
    if (flow > bestFlow) { bestFlow = flow; best = nodeId }
  }
  return best
}

describe('effet d’un changement de signalisation (Veauche)', () => {
  const network = charger()

  it('le réseau importé est simulable et conserve les véhicules', () => {
    const r = executer(network, 1)
    expect(r.network.entered).toBeGreaterThan(100)
    // Invariant du moteur : tout véhicule injecté est soit sorti, soit encore en circulation.
    expect(r.network.entered).toBe(r.network.exited + r.network.inCirculation)
    expect(r.completed).toBe(true)
  })

  it('poser des feux sur le carrefour principal augmente le retard à faible trafic', () => {
    const base = executer(network, 1)
    const nodeId = carrefourPrincipal(network, base)
    expect(nodeId).not.toBe('')

    // Variante : ce carrefour passe aux feux, plan par défaut.
    const plan = createDefaultSignalPlan(network, [nodeId])
    const variante: Network = {
      ...network,
      controls: { ...network.controls, [nodeId]: { nodeId, type: 'signals', controllerId: 'c_test' } },
      controllers: { ...network.controllers, c_test: { id: 'c_test', ...plan } },
    }
    const avecFeux = executer(variante, 1)

    const retardBase = base.intersections[nodeId]
      ? Object.values(base.intersections[nodeId].approaches).reduce((s, a) => s + a.meanDelayS * a.vehicles, 0)
      : 0
    const retardFeux = avecFeux.intersections[nodeId]
      ? Object.values(avecFeux.intersections[nodeId].approaches).reduce((s, a) => s + a.meanDelayS * a.vehicles, 0)
      : 0

    // À trafic faible, des feux coûtent du temps par rapport à une priorité : c'est le résultat attendu.
    expect(retardFeux).toBeGreaterThan(retardBase)
    expect(avecFeux.network.meanDelayS).toBeGreaterThan(base.network.meanDelayS)
  })

  it('allonger le vert de l’axe principal réduit le retard de cet axe', () => {
    const base = executer(network, 3)
    const nodeId = carrefourPrincipal(network, base)
    const plan = createDefaultSignalPlan(network, [nodeId])
    if (plan.phases.length < 2) return // carrefour à une seule phase : rien à arbitrer

    const faire = (vertPrincipal: number) => {
      const phases = plan.phases.map((p, i) => ({ ...p, green: i === 0 ? vertPrincipal : Math.max(7, 80 - vertPrincipal) }))
      const variante: Network = {
        ...network,
        controls: { ...network.controls, [nodeId]: { nodeId, type: 'signals', controllerId: 'c_test' } },
        controllers: { ...network.controllers, c_test: { id: 'c_test', ...plan, phases } },
      }
      const r = executer(variante, 3)
      const approches = r.intersections[nodeId]?.approaches ?? {}
      return { r, approches }
    }

    const court = faire(20)
    const long = faire(60)

    // L'approche la plus chargée profite d'un vert plus long.
    const principale = Object.entries(court.approches)
      .sort((a, b) => b[1].vehicles - a[1].vehicles)[0]?.[0]
    expect(principale).toBeTruthy()
    const retardCourt = court.approches[principale!].meanDelayS
    const retardLong = long.approches[principale!]?.meanDelayS ?? Infinity
    expect(retardLong).toBeLessThan(retardCourt)
  })

  it('fermer un tronçon reporte le trafic sans perdre de véhicules', () => {
    const base = executer(network, 1)
    const charge = Object.entries(base.edges).sort((a, b) => b[1].exited - a[1].exited)
    const cible = charge.find(([id]) => {
      const e = network.edges[id]
      return e && !network.nodes[e.from].boundary && !network.nodes[e.to].boundary
    })
    expect(cible).toBeTruthy()
    const [edgeId] = cible!
    const edge = network.edges[edgeId]

    const variante: Network = {
      ...network,
      edges: {
        ...network.edges,
        [edgeId]: { ...edge, closed: true },
        ...(edge.reverseOf ? { [edge.reverseOf]: { ...network.edges[edge.reverseOf], closed: true } } : {}),
      },
    }
    const apres = executer(variante, 1)
    expect(apres.edges[edgeId].exited).toBe(0)
    expect(apres.network.entered).toBe(apres.network.exited + apres.network.inCirculation)
    // Le trafic n'a pas disparu : la grande majorité des véhicules sort quand même du réseau.
    expect(apres.network.exited).toBeGreaterThan(base.network.exited * 0.7)
  })
})

describe('robustesse de la demande', () => {
  const network = charger()

  it('redirige les véhicules dont la sortie est inatteignable au lieu de les perdre', () => {
    const demand = defaultDemand(network, 7)
    const settings = { ...DEFAULT_SETTINGS, durationMin: 20, warmupMin: 5 }
    const generes = generateArrivals(network, demand, settings).length
    const sim = new Simulation({ network, demand, settings })
    while (!sim.done) sim.step(600)
    const r = sim.results()
    // Moins de 5 % de la demande peut être abandonnée (entrées ne desservant réellement aucune sortie).
    expect(r.network.notInjected / generes).toBeLessThan(0.05)
    expect(r.network.entered).toBe(r.network.exited + r.network.inCirculation)
    expect(generes).toBe(r.network.entered + r.network.notInjected)
  })

  it('reste déterministe malgré les redirections', () => {
    const demand = defaultDemand(network, 7)
    const settings = { ...DEFAULT_SETTINGS, durationMin: 15, warmupMin: 5 }
    const run = () => {
      const sim = new Simulation({ network, demand, settings })
      while (!sim.done) sim.step(600)
      return sim.results()
    }
    const a = run()
    const b = run()
    expect(b.network).toEqual(a.network)
  })
})

describe('cohérence des résultats intermédiaires', () => {
  const network = charger()

  it('ne compte pas les arrivées futures comme non injectées pendant l’exécution', () => {
    const demand = defaultDemand(network, 7)
    const settings = { ...DEFAULT_SETTINGS, durationMin: 30, warmupMin: 5 }
    const sim = new Simulation({ network, demand, settings })
    sim.step(600) // 10 minutes simulées, la simulation est loin d'être finie
    const partiel = sim.results()
    expect(partiel.completed).toBe(false)
    // Les non injectés restent une petite fraction des véhicules entrés, pas la totalité des arrivées à venir.
    expect(partiel.network.notInjected).toBeLessThan(partiel.network.entered)

    while (!sim.done) sim.step(600)
    const final = sim.results()
    const generes = generateArrivals(network, demand, settings).length
    expect(generes).toBe(final.network.entered + final.network.notInjected)
  })
})
