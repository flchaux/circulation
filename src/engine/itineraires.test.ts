import { describe, expect, it } from 'vitest'
import type { NetEdge, NetNode, Network } from '@/model/types'
import { DEFAULT_SETTINGS } from '@/model/defaults'
import { itinerairesLesPlusCourts } from './itineraires'

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
 * Damier de `cote` × `cote` carrefours espacés de 100 m, toutes les rues à double sens.
 * Les nœuds sont nommés `r{ligne}c{colonne}`, les tronçons `{origine}>{destination}`.
 * Il y a beaucoup plus de cinq chemins de `r0c0` à `r{n}c{n}` : de quoi éprouver le classement.
 */
function damier(cote: number): Network {
  const nodes: Record<string, NetNode> = {}
  for (let r = 0; r < cote; r++) {
    for (let c = 0; c < cote; c++) nodes[`r${r}c${c}`] = node(`r${r}c${c}`, c * 100, -r * 100)
  }
  const edges: Record<string, NetEdge> = {}
  const relier = (a: string, b: string): void => {
    edges[`${a}>${b}`] = edge(nodes, `${a}>${b}`, a, b, { reverseOf: `${b}>${a}`, name: `${a}–${b}` })
    edges[`${b}>${a}`] = edge(nodes, `${b}>${a}`, b, a, { reverseOf: `${a}>${b}`, name: `${a}–${b}` })
  }
  for (let r = 0; r < cote; r++) {
    for (let c = 0; c < cote; c++) {
      if (c + 1 < cote) relier(`r${r}c${c}`, `r${r}c${c + 1}`)
      if (r + 1 < cote) relier(`r${r}c${c}`, `r${r + 1}c${c}`)
    }
  }
  return { nodes, edges, controls: {}, controllers: {} }
}

/** Vérifie qu'un itinéraire est réellement praticable : tronçons enchaînés, sans boucle, de A vers B. */
function verifierChemin(network: Network, chemin: { edges: string[]; nodes: string[] }, from: string, to: string): void {
  expect(chemin.edges.length).toBeGreaterThan(0)
  expect(chemin.nodes.length).toBe(chemin.edges.length + 1)
  expect(chemin.nodes[0]).toBe(from)
  expect(chemin.nodes[chemin.nodes.length - 1]).toBe(to)
  expect(new Set(chemin.nodes).size).toBe(chemin.nodes.length)
  let courant = from
  for (const id of chemin.edges) {
    const e = network.edges[id]
    expect(e, `tronçon ${id} inconnu`).toBeDefined()
    expect(e.from).toBe(courant)
    expect(e.closed).toBe(false)
    courant = e.to
  }
  expect(courant).toBe(to)
}

describe('itinerairesLesPlusCourts', () => {
  it('rend cinq itinéraires distincts et praticables, classés du plus rapide au plus lent', () => {
    const net = damier(4)
    const chemins = itinerairesLesPlusCourts(net, 'r0c0', 'r3c3')
    expect(chemins).toHaveLength(5)
    const cles = new Set(chemins.map((c) => c.edges.join(',')))
    expect(cles.size).toBe(5)
    for (const c of chemins) verifierChemin(net, c, 'r0c0', 'r3c3')
    for (let i = 1; i < chemins.length; i++) expect(chemins[i].time).toBeGreaterThanOrEqual(chemins[i - 1].time)
  })

  it('donne au premier itinéraire le temps et la longueur du plus court chemin', () => {
    const net = damier(4)
    const [meilleur] = itinerairesLesPlusCourts(net, 'r0c0', 'r3c3')
    // Six tronçons de 100 m à 50 km/h : aucun détour possible plus court.
    expect(meilleur.length).toBeCloseTo(600, 6)
    expect(meilleur.time).toBeCloseTo(600 / (50 / 3.6), 6)
    expect(meilleur.edges).toHaveLength(6)
  })

  it('préfère l’itinéraire rapide au plus court quand une voie est limitée à 30 km/h', () => {
    const net = damier(3)
    // La rangée du haut passe à 20 km/h : le trajet doit descendre d'abord.
    for (const id of ['r0c0>r0c1', 'r0c1>r0c2']) net.edges[id] = { ...net.edges[id], maxspeed: 20 }
    const [meilleur] = itinerairesLesPlusCourts(net, 'r0c0', 'r2c2')
    expect(meilleur.edges[0]).toBe('r0c0>r1c0')
  })

  it('n’emprunte ni un tronçon fermé, ni un mouvement interdit, ni un sens interdit', () => {
    const net = damier(3)
    net.edges['r0c0>r0c1'] = { ...net.edges['r0c0>r0c1'], closed: true }
    // Descendre puis tourner à gauche vers l'est est interdit au premier carrefour.
    net.edges['r0c0>r1c0'] = { ...net.edges['r0c0>r1c0'], bannedTo: ['r1c0>r1c1'] }
    const chemins = itinerairesLesPlusCourts(net, 'r0c0', 'r2c2')
    expect(chemins.length).toBeGreaterThan(0)
    for (const c of chemins) {
      verifierChemin(net, c, 'r0c0', 'r2c2')
      expect(c.edges).not.toContain('r0c0>r0c1')
      const i = c.edges.indexOf('r0c0>r1c0')
      if (i >= 0) expect(c.edges[i + 1]).not.toBe('r1c0>r1c1')
    }
  })

  it('compte le retard des carrefours traversés, mais pas celui du carrefour d’arrivée', () => {
    const nodes: Record<string, NetNode> = {
      a: node('a', 0, 0), m: node('m', 200, 0), b: node('b', 400, 0), z: node('z', 600, 0),
    }
    const edges: Record<string, NetEdge> = {}
    for (const [from, to] of [['a', 'm'], ['m', 'b'], ['b', 'z']]) {
      edges[`${from}>${to}`] = edge(nodes, `${from}>${to}`, from, to)
      edges[`${to}>${from}`] = edge(nodes, `${to}>${from}`, to, from)
    }
    // `m` (traversé) et `b` (arrivée) imposent tous deux un arrêt.
    const network: Network = {
      nodes,
      edges,
      controls: { m: { nodeId: 'm', type: 'stop' }, b: { nodeId: 'b', type: 'stop' } },
      controllers: {},
    }
    const libre = 400 / (50 / 3.6)
    const arret = DEFAULT_SETTINGS.stopDelay + DEFAULT_SETTINGS.startupLostTime

    const [sansCarrefour] = itinerairesLesPlusCourts(network, 'a', 'b')
    expect(sansCarrefour.time).toBeCloseTo(libre, 6)

    const [avecCarrefour] = itinerairesLesPlusCourts(network, 'a', 'b', { settings: DEFAULT_SETTINGS })
    expect(avecCarrefour.time).toBeCloseTo(libre + arret, 6)
  })

  it('ne rend rien entre deux nœuds confondus, inconnus ou non reliés', () => {
    const net = damier(3)
    expect(itinerairesLesPlusCourts(net, 'r0c0', 'r0c0')).toEqual([])
    expect(itinerairesLesPlusCourts(net, 'r0c0', 'inexistant')).toEqual([])
    net.nodes.isole = node('isole', 999, 999)
    expect(itinerairesLesPlusCourts(net, 'r0c0', 'isole')).toEqual([])
  })

  it('ne traverse pas un nœud frontière et s’arrête à celui qui est demandé', () => {
    const net = damier(3)
    net.nodes.r1c1 = { ...net.nodes.r1c1, boundary: true }
    const chemins = itinerairesLesPlusCourts(net, 'r0c0', 'r2c2')
    for (const c of chemins) {
      verifierChemin(net, c, 'r0c0', 'r2c2')
      expect(c.nodes.slice(1, -1)).not.toContain('r1c1')
    }
  })

  it('respecte le nombre d’itinéraires demandé', () => {
    const net = damier(4)
    expect(itinerairesLesPlusCourts(net, 'r0c0', 'r3c3', { count: 3 })).toHaveLength(3)
    expect(itinerairesLesPlusCourts(net, 'r0c0', 'r3c3', { count: 8 })).toHaveLength(8)
  })
})
