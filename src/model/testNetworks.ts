/** Réseaux synthétiques partagés par les tests du modèle. */
import type { NetEdge, Network } from './types'
import { createDefaultSignalPlan } from './signals'

/** Carrefour en croix : branches nord, sud, est, ouest de 100 m, toutes à double sens. */
export function crossNetwork(): Network {
  const nodes: Network['nodes'] = {
    c: { id: 'c', x: 0, y: 0, boundary: false },
    n: { id: 'n', x: 0, y: 100, boundary: true },
    s: { id: 's', x: 0, y: -100, boundary: true },
    e: { id: 'e', x: 100, y: 0, boundary: true },
    w: { id: 'w', x: -100, y: 0, boundary: true },
  }
  const edges: Record<string, NetEdge> = {}
  const mk = (id: string, from: string, to: string, reverseOf: string): NetEdge => ({
    id, from, to, reverseOf, name: `Rue ${from}${to}`, highway: 'residential', lanes: 1, maxspeed: 50, length: 100,
    geometry: [[nodes[from].x, nodes[from].y], [nodes[to].x, nodes[to].y]],
    roundabout: false, closed: false, bannedTo: [], estimated: { lanes: false, maxspeed: false },
  })
  for (const b of ['n', 's', 'e', 'w']) {
    edges[`${b}_in`] = mk(`${b}_in`, b, 'c', `${b}_out`)
    edges[`${b}_out`] = mk(`${b}_out`, 'c', b, `${b}_in`)
  }
  return { nodes, edges, controls: {}, controllers: {} }
}

/** Ajoute des feux au carrefour central, avec le plan par défaut. */
export function withSignals(net: Network, nodeId = 'c', controllerId = 'c1'): Network {
  const plan = createDefaultSignalPlan(net, [nodeId])
  return {
    ...net,
    controls: { ...net.controls, [nodeId]: { nodeId, type: 'signals', controllerId } },
    controllers: { ...net.controllers, [controllerId]: { id: controllerId, ...plan } },
  }
}
