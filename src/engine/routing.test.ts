import { describe, expect, it } from 'vitest'
import type { NetEdge, NetNode, Network } from '@/model/types'
import { Router, TRAVEL_EMA_TAU, buildGraph, decayTowardFree, queueDelay, shortestPathNodes } from './routing'

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

/**
 * Réseau « losange » : deux itinéraires de A vers X, l'un par P (court), l'autre par Q (long).
 * `mid` est un nœud frontière : le raccourci A→P→mid→Q→X est interdit (on ne traverse pas la frontière).
 */
function diamond(): Network {
  const nodes: Record<string, NetNode> = {
    a: node('a', -300, 0, true),
    p: node('p', -100, 0),
    q: node('q', 100, 0),
    x: node('x', 300, 0, true),
    up: node('up', 0, 400),
    mid: node('mid', 0, -40, true),
  }
  const edges: Record<string, NetEdge> = {}
  const add = (id: string, from: string, to: string, o: Partial<NetEdge> = {}) => { edges[id] = edge(nodes, id, from, to, o) }
  add('a_p', 'a', 'p')
  add('p_mid', 'p', 'mid')
  add('mid_q', 'mid', 'q')
  add('p_up', 'p', 'up')
  add('up_q', 'up', 'q')
  add('q_x', 'q', 'x')
  return { nodes, edges, controls: {}, controllers: {} }
}

describe('buildGraph', () => {
  it('indexe les tronçons dans un ordre stable et calcule les temps libres', () => {
    const g = buildGraph(diamond())
    expect(g.edgeIds).toEqual([...g.edgeIds].sort())
    const i = g.edgeOf.get('a_p')!
    expect(g.length[i]).toBeCloseTo(200, 6)
    expect(g.freeTime[i]).toBeCloseTo(200 / (50 / 3.6), 6)
  })

  it('ne crée aucun successeur au-delà d’un nœud frontière', () => {
    const g = buildGraph(diamond())
    const pMid = g.edgeOf.get('p_mid')!
    expect(g.succStart[pMid + 1] - g.succStart[pMid]).toBe(0)
  })
})

describe('Router', () => {
  it('contourne le nœud frontière et fournit les mouvements de l’itinéraire', () => {
    const network = diamond()
    const g = buildGraph(network)
    const router = new Router(g)
    const route = router.routeFromNodeToExit(g.nodeOf.get('a')!, 'x')
    expect(route).not.toBeNull()
    const ids = [...route!.route].map((i) => g.edgeIds[i])
    expect(ids).toEqual(['a_p', 'p_up', 'up_q', 'q_x'])
    expect(route!.moves.length).toBe(3)
    for (let k = 0; k < route!.moves.length; k++) {
      const mv = route!.moves[k]
      expect(g.movementFrom[mv]).toBe(route!.route[k])
      expect(g.movementTo[mv]).toBe(route!.route[k + 1])
    }
  })

  it('renvoie null quand la destination est inatteignable', () => {
    const network = diamond()
    network.edges.p_up = { ...network.edges.p_up, closed: true }
    const g = buildGraph(network)
    const router = new Router(g)
    expect(router.routeFromNodeToExit(g.nodeOf.get('a')!, 'x')).toBeNull()
  })

  it('atteint un tronçon de destination interne', () => {
    const network = diamond()
    const g = buildGraph(network)
    const router = new Router(g)
    const route = router.routeFromNodeToEdge(g.nodeOf.get('a')!, g.edgeOf.get('up_q')!)
    expect(route).not.toBeNull()
    expect([...route!.route].map((i) => g.edgeIds[i])).toEqual(['a_p', 'p_up', 'up_q'])
  })

  it('suit les coûts mis à jour (routage dynamique)', () => {
    const network = diamond()
    // Un second itinéraire A→P→dn→Q→X, plus long à vide.
    network.nodes.dn = node('dn', 0, -600)
    network.edges.p_dn = edge(network.nodes, 'p_dn', 'p', 'dn')
    network.edges.dn_q = edge(network.nodes, 'dn_q', 'dn', 'q')
    const g = buildGraph(network)
    const router = new Router(g)
    const before = router.routeFromNodeToExit(g.nodeOf.get('a')!, 'x')!
    expect([...before.route].map((i) => g.edgeIds[i])).toContain('p_up')

    const costs = g.freeTime.slice()
    costs[g.edgeOf.get('p_up')!] = 10_000
    router.setCosts(costs)
    const after = router.routeFromNodeToExit(g.nodeOf.get('a')!, 'x')!
    expect([...after.route].map((i) => g.edgeIds[i])).toContain('p_dn')
  })
})

describe('shortestPathNodes', () => {
  it('renvoie le chemin en nœuds sans traverser la frontière', () => {
    expect(shortestPathNodes(diamond(), 'a', 'x')).toEqual(['a', 'p', 'up', 'q', 'x'])
  })

  it('renvoie [] sans chemin et le nœud seul si origine = destination', () => {
    expect(shortestPathNodes(diamond(), 'x', 'a')).toEqual([])
    expect(shortestPathNodes(diamond(), 'p', 'p')).toEqual(['p'])
    expect(shortestPathNodes(diamond(), 'p', 'inconnu')).toEqual([])
  })
})

describe('coût dynamique d’un tronçon', () => {
  it('ramène la moyenne vers le temps à vide faute de mesure', () => {
    // Sans temps écoulé, rien ne bouge : une mesure fraîche fait foi.
    expect(decayTowardFree(120, 20, 0)).toBe(120)
    expect(decayTowardFree(120, 20, -5)).toBe(120)
    // Une constante de temps écoulée retire 63 % de l'écart au temps à vide.
    expect(decayTowardFree(120, 20, TRAVEL_EMA_TAU)).toBeCloseTo(20 + 100 * Math.exp(-1), 6)
    // Un tronçon abandonné finit par retrouver son temps à vide.
    expect(decayTowardFree(120, 20, 20 * TRAVEL_EMA_TAU)).toBeCloseTo(20, 3)
    // Quelques secondes entre deux passages ne changent presque rien : un tronçon fréquenté
    // garde la mémoire de ses mesures.
    expect(decayTowardFree(120, 20, 2)).toBeGreaterThan(119)
  })

  it('majore le coût d’un tronçon selon la file présente', () => {
    const debit = 0.5 // véh/s, soit 1 800 véh/h sur une voie
    expect(queueDelay(0, 40, debit)).toBe(0)
    // Sans débit de décharge connu, pas de majoration inventée.
    expect(queueDelay(10, 40, 0)).toBe(0)
    // Tronçon peu occupé : l'attente est simplement l'écoulement de la file, sans majoration.
    expect(queueDelay(10, 40, debit)).toBeCloseTo(20, 0)
    // La majoration croît avec la file…
    expect(queueDelay(20, 40, debit)).toBeGreaterThan(queueDelay(10, 40, debit))
    // … et le stockage saturé (remontée de file) coûte bien plus que le seul écoulement.
    expect(queueDelay(40, 40, debit)).toBeGreaterThan(10 * queueDelay(4, 40, debit))
    // À file égale, un tronçon court (donc plein) est plus pénalisé qu'un tronçon long.
    expect(queueDelay(20, 20, debit)).toBeGreaterThan(queueDelay(20, 200, debit))
  })
})
