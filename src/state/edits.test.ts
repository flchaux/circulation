import { describe, expect, it } from 'vitest'
import type { NetEdge, NetNode, Network, SignalController } from '@/model/types'
import {
  addEdge, deleteEdge, deleteNode, mergeNodes, moveNode, sanitizeNetwork, setBannedTurn, setEdgeDirection,
} from './edits'

/* ------------------------------------------------------------------ */
/*  Réseaux de test construits à la main (aucun appel à osm2graph)     */
/* ------------------------------------------------------------------ */

function node(id: string, x: number, y: number, boundary = false): NetNode {
  return { id, x, y, boundary }
}

function edge(id: string, from: NetNode, to: NetNode, extra: Partial<NetEdge> = {}): NetEdge {
  const geometry: [number, number][] = [[from.x, from.y], [to.x, to.y]]
  return {
    id,
    from: from.id,
    to: to.id,
    highway: 'residential',
    lanes: 1,
    maxspeed: 50,
    length: Math.hypot(to.x - from.x, to.y - from.y),
    geometry,
    roundabout: false,
    closed: false,
    bannedTo: [],
    estimated: { lanes: false, maxspeed: false },
    ...extra,
  }
}

/** Croisement en croix : nœud central `n0`, quatre branches frontières à 100 m, toutes à double sens. */
function crossNetwork(): Network {
  const centre = node('n0', 0, 0)
  const branches: Record<string, NetNode> = {
    N: node('nN', 0, 100, true),
    S: node('nS', 0, -100, true),
    E: node('nE', 100, 0, true),
    W: node('nW', -100, 0, true),
  }
  const nodes: Record<string, NetNode> = { n0: centre }
  const edges: Record<string, NetEdge> = {}
  for (const [key, branch] of Object.entries(branches)) {
    nodes[branch.id] = branch
    const inId = `e${key}in`
    const outId = `e${key}out`
    edges[inId] = edge(inId, branch, centre, { reverseOf: outId })
    edges[outId] = edge(outId, centre, branch, { reverseOf: inId })
  }
  return { nodes, edges, controls: {}, controllers: {} }
}

function controller(extra: Partial<SignalController> = {}): SignalController {
  return {
    id: 'c1',
    name: 'Carrefour',
    nodeIds: ['n0'],
    mode: 'fixed',
    offset: 0,
    amber: 3,
    allRed: 2,
    phases: [{ id: 'p1', name: 'Axe principal', green: 30, movements: {}, minGreen: 7, maxGreen: 60, gap: 3 }],
    actuated: { skipEmpty: true },
    ...extra,
  }
}

/* ------------------------------------------------------------------ */

describe('sanitizeNetwork', () => {
  it('laisse un réseau valide intact (même identité)', () => {
    const network = crossNetwork()
    expect(sanitizeNetwork(network)).toBe(network)
  })

  it('supprime les tronçons dont une extrémité a disparu', () => {
    const network = crossNetwork()
    const nodes = { ...network.nodes }
    delete nodes.nN
    const cleaned = sanitizeNetwork({ ...network, nodes })
    expect(cleaned.edges.eNin).toBeUndefined()
    expect(cleaned.edges.eNout).toBeUndefined()
    expect(Object.keys(cleaned.edges)).toHaveLength(6)
    // Le `reverseOf` des survivants reste symétrique.
    expect(cleaned.edges.eSin.reverseOf).toBe('eSout')
  })

  it('ne conserve une interdiction de tourner que si elle part du nœud aval', () => {
    const network = crossNetwork()
    const dirty: Network = {
      ...network,
      edges: {
        ...network.edges,
        // eSout part de n0 : valide depuis eNin (qui arrive en n0) ; eNin ne part pas de n0 : invalide ; eZ n'existe pas.
        eNin: { ...network.edges.eNin, bannedTo: ['eSout', 'eNin', 'eZ'] },
      },
    }
    expect(sanitizeNetwork(dirty).edges.eNin.bannedTo).toEqual(['eSout'])
  })

  it('efface un `reverseOf` non symétrique', () => {
    const network = crossNetwork()
    const dirty: Network = {
      ...network,
      edges: { ...network.edges, eNout: { ...network.edges.eNout, reverseOf: 'eSin' } },
    }
    const cleaned = sanitizeNetwork(dirty)
    expect(cleaned.edges.eNout.reverseOf).toBeUndefined()
    expect(cleaned.edges.eNin.reverseOf).toBeUndefined()
    expect(cleaned.edges.eSin.reverseOf).toBe('eSout')
  })

  it('purge les mouvements de phase invalides et les nœuds disparus des contrôleurs', () => {
    const network = crossNetwork()
    const c = controller({
      nodeIds: ['n0', 'nDisparu'],
      phases: [{
        id: 'p1',
        name: 'Axe principal',
        green: 30,
        movements: {
          'eNin>eSout': 'protected', // valide
          'eNin>eZout': 'protected', // tronçon inexistant
          'eNout>eNin': 'protected', // s'enchaîne en nN, hors du regroupement
          'eNin>eEin': 'protected', // eEin ne part pas de n0
        },
        minGreen: 7,
        maxGreen: 60,
        gap: 3,
      }],
    })
    const cleaned = sanitizeNetwork({
      ...network,
      controllers: { c1: c },
      controls: { n0: { nodeId: 'n0', type: 'signals', controllerId: 'c1' } },
    })
    expect(cleaned.controllers.c1.nodeIds).toEqual(['n0'])
    expect(Object.keys(cleaned.controllers.c1.phases[0].movements)).toEqual(['eNin>eSout'])
  })

  it('supprime un contrôleur sans nœud et la régulation qui le référence', () => {
    const network = crossNetwork()
    const cleaned = sanitizeNetwork({
      ...network,
      controllers: { c1: controller({ nodeIds: ['nDisparu'] }) },
      controls: { n0: { nodeId: 'n0', type: 'signals', controllerId: 'c1' } },
    })
    expect(cleaned.controllers.c1).toBeUndefined()
    expect(cleaned.controls.n0).toBeUndefined()
  })

  it('purge les régulations de nœuds disparus et les approches disparues', () => {
    const network = crossNetwork()
    const cleaned = sanitizeNetwork({
      ...network,
      controls: {
        n0: { nodeId: 'n0', type: 'stop', yieldEdges: ['eNin', 'eDisparu'] },
        nX: { nodeId: 'nX', type: 'give_way' },
      },
    })
    expect(cleaned.controls.n0.yieldEdges).toEqual(['eNin'])
    expect(cleaned.controls.nX).toBeUndefined()
  })

  it('est idempotent', () => {
    const network = crossNetwork()
    const nodes = { ...network.nodes }
    delete nodes.nN
    const once = sanitizeNetwork({ ...network, nodes })
    expect(sanitizeNetwork(once)).toBe(once)
  })
})

describe('moveNode', () => {
  it('arrondit au centimètre et met à jour géométries et longueurs', () => {
    const network = crossNetwork()
    const moved = moveNode(network, 'n0', 10.123, -5.678)
    expect(moved.nodes.n0.x).toBe(10.12)
    expect(moved.nodes.n0.y).toBe(-5.68)
    expect(moved.edges.eNin.geometry[1]).toEqual([10.12, -5.68])
    expect(moved.edges.eNout.geometry[0]).toEqual([10.12, -5.68])
    expect(moved.edges.eNin.length).toBeCloseTo(Math.hypot(10.12, 100 + 5.68), 6)
    // Aucun tronçon non incident n'est recréé (identité préservée pour le cache du rendu).
    expect(moved.edges.eEin).not.toBe(network.edges.eEin)
    expect(moved.nodes.nN).toBe(network.nodes.nN)
  })

  it('ne recrée rien si la position est inchangée', () => {
    const network = crossNetwork()
    expect(moveNode(network, 'n0', 0, 0)).toBe(network)
    expect(moveNode(network, 'inconnu', 5, 5)).toBe(network)
  })
})

describe('mergeNodes', () => {
  it('rebranche les tronçons et supprime ceux devenus des boucles', () => {
    const network = crossNetwork()
    const merged = mergeNodes(network, 'nW', 'n0')
    expect(merged.nodes.nW).toBeUndefined()
    expect(merged.edges.eWin).toBeUndefined()
    expect(merged.edges.eWout).toBeUndefined()
    expect(Object.keys(merged.edges).sort()).toEqual(['eEin', 'eEout', 'eNin', 'eNout', 'eSin', 'eSout'])
  })

  it('conserve le plus court des doublons et met à jour reverseOf, régulations et contrôleurs', () => {
    const a = node('a', 0, 0)
    const b = node('b', 10, 0)
    const c = node('c', 50, 0)
    const direct = edge('ab', a, b)
    const detour = edge('ac', a, c, { geometry: [[0, 0], [0, 40], [50, 0]], length: 104 })
    const back = edge('ba', b, a, { reverseOf: 'ab' })
    direct.reverseOf = 'ba'
    const network: Network = {
      nodes: { a, b, c },
      edges: { ab: direct, ac: detour, ba: back },
      controls: { c: { nodeId: 'c', type: 'stop', yieldEdges: ['ac'] } },
      controllers: {},
    }
    const merged = mergeNodes(network, 'c', 'b')
    // `ac` devient a→b : doublon plus long que `ab`, il disparaît.
    expect(merged.edges.ac).toBeUndefined()
    expect(merged.edges.ab.reverseOf).toBe('ba')
    // La régulation de la source suit la cible ; son approche disparue est purgée.
    expect(merged.controls.b).toEqual({ nodeId: 'b', type: 'stop', yieldEdges: [] })
  })

  it('reporte la source sur la cible dans les contrôleurs de feux', () => {
    const network = crossNetwork()
    const withSignals: Network = {
      ...network,
      controllers: { c1: controller({ nodeIds: ['nW'] }) },
      controls: { nW: { nodeId: 'nW', type: 'signals', controllerId: 'c1' } },
    }
    const merged = mergeNodes(withSignals, 'nW', 'n0')
    expect(merged.controllers.c1.nodeIds).toEqual(['n0'])
    expect(merged.controls.n0).toEqual({ nodeId: 'n0', type: 'signals', controllerId: 'c1' })
  })

  it('ignore une fusion impossible', () => {
    const network = crossNetwork()
    expect(mergeNodes(network, 'n0', 'n0')).toBe(network)
    expect(mergeNodes(network, 'inconnu', 'n0')).toBe(network)
  })
})

describe('setEdgeDirection', () => {
  it('« oneway » supprime le tronçon opposé', () => {
    const network = crossNetwork()
    const oneway = setEdgeDirection(network, 'eNin', 'oneway')
    expect(oneway.edges.eNout).toBeUndefined()
    expect(oneway.edges.eNin.reverseOf).toBeUndefined()
    expect(Object.keys(oneway.edges)).toHaveLength(7)
  })

  it('« reverse » échange les extrémités, inverse la géométrie et vide les interdictions', () => {
    const network = crossNetwork()
    const withBan: Network = {
      ...network,
      edges: { ...network.edges, eNin: { ...network.edges.eNin, bannedTo: ['eSout'] } },
    }
    const reversed = setEdgeDirection(withBan, 'eNin', 'reverse')
    const e = reversed.edges.eNin
    expect(e.from).toBe('n0')
    expect(e.to).toBe('nN')
    expect(e.geometry).toEqual([[0, 0], [0, 100]])
    expect(e.length).toBeCloseTo(100, 6)
    expect(e.bannedTo).toEqual([])
    expect(e.reverseOf).toBeUndefined()
    expect(reversed.edges.eNout).toBeUndefined()
  })

  it('« twoway » crée le tronçon opposé « {id}r » et la symétrie', () => {
    const network = crossNetwork()
    const oneway = setEdgeDirection(network, 'eNin', 'oneway')
    const twoway = setEdgeDirection(oneway, 'eNin', 'twoway')
    const back = twoway.edges.eNinr
    expect(back).toBeDefined()
    expect(back.from).toBe('n0')
    expect(back.to).toBe('nN')
    expect(back.geometry).toEqual([[0, 0], [0, 100]])
    expect(back.reverseOf).toBe('eNin')
    expect(twoway.edges.eNin.reverseOf).toBe('eNinr')
    // Un tronçon déjà à double sens n'est pas dupliqué.
    expect(setEdgeDirection(twoway, 'eNin', 'twoway')).toBe(twoway)
  })
})

describe('ajout et suppression', () => {
  it('addEdge numérote « x1 » puis « x1r » pour le sens opposé', () => {
    const network = crossNetwork()
    const withEdge = addEdge(network, 'nN', 'nE', { twoWay: true, highway: 'tertiary', lanes: 2, maxspeed: 30 })
    expect(withEdge.edges.x1.from).toBe('nN')
    expect(withEdge.edges.x1.lanes).toBe(2)
    expect(withEdge.edges.x1.estimated).toEqual({ lanes: false, maxspeed: false })
    expect(withEdge.edges.x1r.from).toBe('nE')
    expect(withEdge.edges.x1.reverseOf).toBe('x1r')
    expect(withEdge.edges.x1.length).toBeCloseTo(Math.hypot(100, 100), 6)
    const second = addEdge(withEdge, 'nS', 'nW', { twoWay: false, highway: 'residential', lanes: 1, maxspeed: 50 })
    expect(second.edges.x2).toBeDefined()
    expect(second.edges.x2r).toBeUndefined()
  })

  it('deleteNode retire le nœud et ses tronçons incidents', () => {
    const network = crossNetwork()
    const pruned = deleteNode(network, 'nN')
    expect(pruned.nodes.nN).toBeUndefined()
    expect(Object.keys(pruned.edges).sort()).toEqual(['eEin', 'eEout', 'eSin', 'eSout', 'eWin', 'eWout'])
  })

  it('deleteEdge ne supprime que le sens demandé', () => {
    const network = crossNetwork()
    const pruned = deleteEdge(network, 'eNin')
    expect(pruned.edges.eNin).toBeUndefined()
    expect(pruned.edges.eNout.reverseOf).toBeUndefined()
  })

  it('setBannedTurn ajoute puis retire une interdiction', () => {
    const network = crossNetwork()
    const banned = setBannedTurn(network, 'eNin', 'eSout', true)
    expect(banned.edges.eNin.bannedTo).toEqual(['eSout'])
    expect(setBannedTurn(banned, 'eNin', 'eSout', true)).toBe(banned)
    expect(setBannedTurn(banned, 'eNin', 'eSout', false).edges.eNin.bannedTo).toEqual([])
  })
})
