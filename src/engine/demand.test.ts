import { describe, expect, it } from 'vitest'
import type { Demand, NetEdge, NetNode, Network, SimSettings } from '@/model/types'
import { DEFAULT_SETTINGS } from '@/model/defaults'
import { generateArrivals } from './demand'

function node(id: string, x: number, y: number, boundary = false): NetNode {
  return { id, x, y, boundary }
}

function edge(nodes: Record<string, NetNode>, id: string, from: string, to: string, o: Partial<NetEdge> = {}): NetEdge {
  const a = nodes[from]
  const b = nodes[to]
  return {
    id, from, to, highway: 'residential', lanes: 1, maxspeed: 50,
    length: Math.hypot(b.x - a.x, b.y - a.y),
    geometry: [[a.x, a.y], [b.x, b.y]],
    roundabout: false, closed: false, bannedTo: [], estimated: { lanes: false, maxspeed: false },
    ...o,
  }
}

/** Deux entrées à l'ouest et au sud, deux sorties à l'est et au nord, et un tronçon interne. */
function net(interiorSpeed = 50): Network {
  const nodes: Record<string, NetNode> = {
    w: node('w', -200, 0, true),
    s: node('s', 0, -200, true),
    e: node('e', 200, 0, true),
    n: node('n', 0, 200, true),
    c: node('c', 0, 0),
    c2: node('c2', 60, 0),
  }
  const edges: Record<string, NetEdge> = {}
  const add = (id: string, from: string, to: string, o: Partial<NetEdge> = {}) => { edges[id] = edge(nodes, id, from, to, o) }
  add('w_in', 'w', 'c')
  add('s_in', 's', 'c')
  add('mid', 'c', 'c2', { maxspeed: interiorSpeed })
  add('e_out', 'c2', 'e', { reverseOf: 'e_in' })
  add('e_in', 'e', 'c2', { reverseOf: 'e_out' })
  add('n_out', 'c', 'n')
  return { nodes, edges, controls: {}, controllers: {} }
}

function demand(o: Partial<Demand> = {}): Demand {
  return {
    seed: 42,
    globalFactor: 1,
    entries: {
      w: { flow: 600, enabled: true, estimated: false },
      s: { flow: 300, enabled: true, estimated: false },
    },
    exits: {
      e: { weight: 1, enabled: true },
      n: { weight: 1, enabled: true },
    },
    destinationMode: 'weights',
    od: {},
    internal: { enabled: false, generationRate: 300, internalDestinationShare: 0.5, entryInternalShare: 0.2 },
    ...o,
  }
}

const settings: SimSettings = { ...DEFAULT_SETTINGS, durationMin: 60, warmupMin: 0 }

describe('generateArrivals', () => {
  it('respecte le débit demandé et l’horizon', () => {
    const arrivals = generateArrivals(net(), demand(), settings)
    const fromW = arrivals.filter((a) => a.entryId === 'w')
    const fromS = arrivals.filter((a) => a.entryId === 's')
    expect(fromW.length).toBeGreaterThan(540)
    expect(fromW.length).toBeLessThan(660)
    expect(fromS.length).toBeGreaterThan(255)
    expect(fromS.length).toBeLessThan(345)
    for (const a of arrivals) {
      expect(a.time).toBeGreaterThanOrEqual(0)
      expect(a.time).toBeLessThan(3600)
    }
  })

  it('trie les arrivées par horodatage', () => {
    const arrivals = generateArrivals(net(), demand(), settings)
    for (let i = 1; i < arrivals.length; i++) expect(arrivals[i].time).toBeGreaterThanOrEqual(arrivals[i - 1].time)
  })

  it('applique le facteur global', () => {
    const base = generateArrivals(net(), demand(), settings).length
    const doubled = generateArrivals(net(), demand({ globalFactor: 2 }), settings).length
    expect(doubled / base).toBeGreaterThan(1.8)
    expect(doubled / base).toBeLessThan(2.2)
  })

  it('variables aléatoires communes : réseau modifié ailleurs, mêmes arrivées', () => {
    const a = generateArrivals(net(50), demand(), settings)
    // Le tronçon interne « mid » change de vitesse : la demande et les nœuds frontières sont identiques.
    const b = generateArrivals(net(30), demand(), settings)
    expect(b).toEqual(a)
  })

  it('variables aléatoires communes : modifier une entrée ne décale pas les autres', () => {
    const base = generateArrivals(net(), demand(), settings).filter((x) => x.entryId === 's')
    const modified = generateArrivals(
      net(),
      demand({ entries: { w: { flow: 1200, enabled: true, estimated: false }, s: { flow: 300, enabled: true, estimated: false } } }),
      settings,
    ).filter((x) => x.entryId === 's')
    expect(modified).toEqual(base)
  })

  it('n’envoie jamais un véhicule vers la sortie portée par son nœud d’entrée', () => {
    const d = demand({
      entries: { e: { flow: 1200, enabled: true, estimated: false } },
      exits: { e: { weight: 5, enabled: true }, n: { weight: 1, enabled: true } },
    })
    const arrivals = generateArrivals(net(), d, settings)
    expect(arrivals.length).toBeGreaterThan(0)
    expect(arrivals.every((a) => a.exitId !== 'e')).toBe(true)
  })

  it('suit la matrice OD quand le mode est « od »', () => {
    const d = demand({ destinationMode: 'od', od: { w: { n: 1 }, s: { e: 1 } } })
    const arrivals = generateArrivals(net(), d, settings)
    expect(arrivals.filter((a) => a.entryId === 'w').every((a) => a.exitId === 'n')).toBe(true)
    expect(arrivals.filter((a) => a.entryId === 's').every((a) => a.exitId === 'e')).toBe(true)
  })

  it('génère le trafic interne et des destinations internes', () => {
    const d = demand({
      internal: { enabled: true, generationRate: 600, internalDestinationShare: 1, entryInternalShare: 1 },
    })
    const arrivals = generateArrivals(net(), d, settings)
    const internalOrigin = arrivals.filter((a) => a.entryId === null)
    expect(internalOrigin.length).toBeGreaterThan(500)
    // Le seul tronçon interne (les deux extrémités hors frontière) est « mid ».
    expect(internalOrigin.every((a) => a.originEdgeId === 'mid')).toBe(true)
    // Une destination interne distincte de l'origine est impossible ici : repli sur une sortie.
    expect(internalOrigin.every((a) => a.exitId !== null)).toBe(true)
    const fromEntries = arrivals.filter((a) => a.entryId !== null)
    expect(fromEntries.every((a) => a.destEdgeId === 'mid')).toBe(true)
  })

  it('ignore les entrées désactivées et à débit nul', () => {
    const d = demand({
      entries: {
        w: { flow: 600, enabled: false, estimated: false },
        s: { flow: 0, enabled: true, estimated: false },
      },
    })
    expect(generateArrivals(net(), d, settings)).toEqual([])
  })
})
