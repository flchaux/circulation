/**
 * Amortissement des recalculs et partage des véhicules entre itinéraires (§5.5).
 *
 * Deux défauts de l'affectation « tout ou rien » sont visés :
 *  - la table de coûts était remplacée d'un bloc à chaque recalcul, ce qui faisait basculer tout le
 *    trafic d'un itinéraire à l'autre, puis revenir cinq minutes plus tard ;
 *  - à un instant donné, tous les véhicules lisaient la même table, donc prenaient le même chemin,
 *    même quand deux itinéraires se valent à quelques secondes près.
 */
import { describe, expect, it } from 'vitest'
import type { Demand, NetEdge, Network, SimSettings } from '@/model/types'
import { DEFAULT_SETTINGS } from '@/model/defaults'
import { Simulation } from '@/engine/simulation'
import { applyVariant, buildGraph, smoothCosts, structuralDelays, variantFactors } from '@/engine/routing'
import { buildPriorityTables } from '@/engine/priority'
import { SignalEngine } from '@/engine/signals'

/**
 * Deux itinéraires presque équivalents entre l'entrée O et la sortie D :
 *  - par A : 360 m, mais son raccordement cède le passage au carrefour J (+2 s de coût structurel) ;
 *  - par B : 420 m sans cession.
 * Soit 27,9 s contre 30,2 s à vide : 8 % d'écart. Tant que tous les véhicules lisent la même table de
 * coûts, le second n'est jamais choisi — c'est ce que les variantes corrigent.
 */
function deuxItinerairesProches(): Network {
  const nodes: Network['nodes'] = {
    O: { id: 'O', x: -100, y: 0, boundary: true },
    S: { id: 'S', x: 0, y: 0, boundary: false },
    A: { id: 'A', x: 200, y: 100, boundary: false },
    B: { id: 'B', x: 200, y: -110, boundary: false },
    J: { id: 'J', x: 400, y: 0, boundary: false },
    D: { id: 'D', x: 500, y: 0, boundary: true },
  }
  const edges: Record<string, NetEdge> = {}
  const arc = (id: string, from: string, to: string, length: number): void => {
    const a = nodes[from]
    const b = nodes[to]
    edges[id] = {
      id, from, to, name: id, highway: 'residential', lanes: 1, maxspeed: 50, length,
      geometry: [[a.x, a.y], [b.x, b.y]],
      roundabout: false, closed: false, bannedTo: [], estimated: { lanes: false, maxspeed: false },
    }
  }
  arc('oS', 'O', 'S', 100)
  arc('sA', 'S', 'A', 180)
  arc('aJ', 'A', 'J', 180)
  arc('sB', 'S', 'B', 210)
  arc('bJ', 'B', 'J', 210)
  arc('jD', 'J', 'D', 100)
  return { nodes, edges, controls: {}, controllers: {} }
}

function demande(flow: number, seed = 5): Demand {
  return {
    seed,
    globalFactor: 1,
    entries: { O: { flow, enabled: true, estimated: false } },
    exits: { D: { weight: 1, enabled: true } },
    destinationMode: 'weights',
    od: {},
    internal: { enabled: false, generationRate: 0, internalDestinationShare: 0, entryInternalShare: 0 },
  }
}

type Reglages = Partial<SimSettings> & { routingSmoothing?: number; routeVariants?: number; routePerturbation?: number }

function simuler(o: Reglages = {}, flow = 150, seed = 5) {
  const settings = {
    ...DEFAULT_SETTINGS, durationMin: 30, warmupMin: 0, dynamicRouting: true, routingIntervalMin: 5,
    statsIntervalMin: 5, ...o,
  } as SimSettings
  const sim = new Simulation({ network: deuxItinerairesProches(), demand: demande(flow, seed), settings })
  while (!sim.done) sim.step(600)
  const r = sim.results()
  const parA = r.series.edges.sA?.flow ?? []
  const parB = r.series.edges.sB?.flow ?? []
  return {
    total: { parA: r.edges.sA?.entered ?? 0, parB: r.edges.sB?.entered ?? 0 },
    /** Part de l'itinéraire long dans chaque tranche de 5 minutes. */
    partB: parA.map((a, i) => (a + parB[i] > 0 ? parB[i] / (a + parB[i]) : 0)),
  }
}

describe('amortissement des coûts', () => {
  it('mêle la table précédente à l’observation', () => {
    const prev = Float64Array.from([10, 20])
    const obs = Float64Array.from([20, 20])
    expect([...smoothCosts(prev, obs, 0.25)]).toEqual([12.5, 20])
    // Premier recalcul, ou remplacement pur : l'observation telle quelle.
    expect(smoothCosts(null, obs, 0.25)).toBe(obs)
    expect(smoothCosts(prev, obs, 1)).toBe(obs)
  })
})

describe('variantes de coûts', () => {
  it('sont reproductibles, centrées et bornées', () => {
    const a = variantFactors(200, 42, 1, 0.15)
    const b = variantFactors(200, 42, 1, 0.15)
    expect([...a]).toEqual([...b])
    expect([...variantFactors(200, 42, 2, 0.15)]).not.toEqual([...a])
    const moyenne = a.reduce((s, x) => s + x, 0) / a.length
    expect(moyenne).toBeGreaterThan(0.95)
    expect(moyenne).toBeLessThan(1.05)
    for (const f of a) expect(f).toBeGreaterThanOrEqual(0.85)
    for (const f of a) expect(f).toBeLessThanOrEqual(1.15)
    // Amplitude nulle : aucune perturbation, les coûts restent ceux du modèle.
    expect([...variantFactors(4, 42, 0, 0)]).toEqual([1, 1, 1, 1])
  })

  it('multiplient les coûts terme à terme', () => {
    const out = new Float64Array(2)
    expect([...applyVariant(Float64Array.from([10, 20]), Float64Array.from([1.1, 0.9]), out)])
      .toEqual([11, 18])
  })
})

describe('coût structurel des carrefours', () => {
  /** Réseau en croix : l'avenue est prioritaire, la rue transversale porte un stop. */
  function croisement(controls: Network['controls'] = {}): Network {
    const nodes: Network['nodes'] = {
      c: { id: 'c', x: 0, y: 0, boundary: false },
      w: { id: 'w', x: -200, y: 0, boundary: true },
      e: { id: 'e', x: 200, y: 0, boundary: true },
      n: { id: 'n', x: 0, y: 200, boundary: true },
      s: { id: 's', x: 0, y: -200, boundary: true },
    }
    const edges: Record<string, NetEdge> = {}
    const arc = (id: string, from: string, to: string, highway: NetEdge['highway']): void => {
      const a = nodes[from]
      const b = nodes[to]
      edges[id] = {
        id, from, to, name: id, highway, lanes: 1, maxspeed: 50,
        length: Math.hypot(b.x - a.x, b.y - a.y), geometry: [[a.x, a.y], [b.x, b.y]],
        roundabout: false, closed: false, bannedTo: [], estimated: { lanes: false, maxspeed: false },
      }
    }
    arc('wc', 'w', 'c', 'secondary'); arc('ce', 'c', 'e', 'secondary')
    arc('nc', 'n', 'c', 'residential'); arc('cs', 'c', 's', 'residential')
    return { nodes, edges, controls, controllers: {} }
  }

  function retards(net: Network): Record<string, number> {
    const g = buildGraph(net)
    const sig = new SignalEngine(g, net, { startTimeOfDayMin: 480, dayOfWeek: 2, seed: 1 })
    const prio = buildPriorityTables(g, net, DEFAULT_SETTINGS, sig.signalizedNodes)
    const d = structuralDelays(
      g, sig.signalDelayByEdge(), prio.yielding, prio.stopRequired,
      DEFAULT_SETTINGS.stopDelay, DEFAULT_SETTINGS.startupLostTime,
    )
    return Object.fromEntries(g.edgeIds.map((id, i) => [id, d[i]]))
  }

  it('compte l’arrêt et le redémarrage d’un stop, et rien sur la voie prioritaire', () => {
    const d = retards(croisement({ c: { nodeId: 'c', type: 'stop', yieldEdges: ['nc'] } }))
    // L'approche qui porte le stop : temps d'arrêt + temps perdu au redémarrage.
    expect(d.nc).toBeCloseTo(DEFAULT_SETTINGS.stopDelay + DEFAULT_SETTINGS.startupLostTime, 6)
    // L'avenue prioritaire ne perd rien ; les tronçons qui sortent du carrefour non plus.
    expect(d.wc).toBe(0)
    expect(d.ce).toBe(0)
    expect(d.cs).toBe(0)
  })

  it('ne compte qu’un redémarrage quand la cession se fait sans arrêt', () => {
    // Priorité par classe : la rue résidentielle cède à l'axe secondaire, sans arrêt obligatoire.
    const d = retards(croisement())
    expect(d.nc).toBeCloseTo(DEFAULT_SETTINGS.startupLostTime, 6)
    expect(d.wc).toBe(0)
  })

  it('compte le retard uniforme d’un feu, d’après sa part de vert', () => {
    const net = croisement({ c: { nodeId: 'c', type: 'signals', controllerId: 'ctl' } })
    net.controllers = {
      ctl: {
        id: 'ctl', name: 'Croix', nodeIds: ['c'], mode: 'fixed', offset: 0, amber: 3, allRed: 2,
        phases: [
          { id: 'p1', name: 'Axe', green: 40, movements: { 'wc>ce': 'protected' }, minGreen: 7, maxGreen: 60, gap: 3 },
          { id: 'p2', name: 'Transversale', green: 20, movements: { 'nc>cs': 'protected' }, minGreen: 7, maxGreen: 60, gap: 3 },
        ],
        actuated: { skipEmpty: false },
      },
    }
    const d = retards(net)
    // Cycle = 40 + 20 + 2 × (3 + 2) = 70 s. Part de vert 40/70 pour l'axe, 20/70 pour la transversale.
    const webster = (u: number): number => (70 * (1 - u) ** 2) / 2
    expect(d.wc).toBeCloseTo(webster(40 / 70), 3)
    expect(d.nc).toBeCloseTo(webster(20 / 70), 3)
    // La transversale, moins servie, coûte plus cher : 17,9 s contre 11,4 s.
    expect(d.nc).toBeGreaterThan(d.wc)
  })
})

describe('partage entre deux itinéraires presque équivalents', () => {
  it('sans variantes, tout le trafic prend le même chemin', () => {
    const { partB, total } = simuler({ routeVariants: 1 })
    console.log(`  1 variante  : part du long par tranche = ${partB.map((x) => x.toFixed(2)).join(' ')}`)
    // Une seule table de coûts, donc une seule réponse : l'itinéraire à 8 % de plus n'est jamais essayé,
    // quand bien même le premier écoulerait mieux le trafic en s'en délestant.
    expect(total.parB).toBe(0)
    for (const part of partB) expect(part).toBe(0)
  })

  it('avec variantes, les deux itinéraires sont employés en même temps', () => {
    const { partB, total } = simuler({ routeVariants: 3 })
    console.log(`  3 variantes : part du long par tranche = ${partB.map((x) => x.toFixed(2)).join(' ')}`)
    console.log(`                total ${total.parA} par A (400 m), ${total.parB} par B (420 m)`)
    // Aucune tranche n'est entièrement d'un côté : le flux se partage au lieu de se relayer.
    for (const part of partB) {
      expect(part).toBeGreaterThan(0.05)
      expect(part).toBeLessThan(0.95)
    }
    // L'itinéraire réellement le plus court reste majoritaire : la perturbation départage, elle n'invente pas.
    expect(total.parA).toBeGreaterThan(total.parB)
  })

  it('reste reproductible : même graine, même partage', () => {
    expect(simuler({ routeVariants: 3 }).total).toEqual(simuler({ routeVariants: 3 }).total)
  })

  it('ne s’applique pas en routage statique : le plus court chemin le reste', () => {
    const { total } = simuler({ dynamicRouting: false, routeVariants: 3 })
    expect(total.parB).toBe(0)
    expect(total.parA).toBeGreaterThan(50)
  })
})
