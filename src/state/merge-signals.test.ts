/**
 * Régression : une fusion de nœuds sur un carrefour à feux ne doit plus laisser de mouvement au rouge
 * permanent. Cas rapporté par un utilisateur sur son projet de Veauche.
 */
import { describe, expect, it } from 'vitest'
import { buildAdjacency } from '@/model/geometry'
import { controllerMovements, validateController } from '@/model/signals'
import { crossNetwork, withSignals } from '@/model/testNetworks'
import { createAppStore } from './store'
import type { SimClientLike } from '@/engine/protocol'
import type { NetEdge, Network, Project } from '@/model/types'
import { DEFAULT_SETTINGS, defaultDemand, ATTRIBUTION } from '@/model/defaults'
import { PROJECT_FORMAT, PROJECT_VERSION } from '@/model/types'

const clientInerte = (): SimClientLike => ({ send: () => {}, dispose: () => {} })

/** Ajoute au carrefour en croix une cinquième branche rattachée à un nœud voisin, à fusionner ensuite. */
function avecBrancheVoisine(net: Network): Network {
  const nodes = {
    ...net.nodes,
    v: { id: 'v', x: 10, y: 10, boundary: false },
    nw: { id: 'nw', x: -70, y: 70, boundary: true },
  }
  const mk = (id: string, from: string, to: string, reverseOf: string): NetEdge => ({
    id, from, to, reverseOf, name: 'Rue Voisine', highway: 'residential', lanes: 1, maxspeed: 50,
    length: Math.hypot(nodes[to as keyof typeof nodes].x - nodes[from as keyof typeof nodes].x,
      nodes[to as keyof typeof nodes].y - nodes[from as keyof typeof nodes].y),
    geometry: [[nodes[from as keyof typeof nodes].x, nodes[from as keyof typeof nodes].y],
      [nodes[to as keyof typeof nodes].x, nodes[to as keyof typeof nodes].y]],
    roundabout: false, closed: false, bannedTo: [], estimated: { lanes: false, maxspeed: false },
  })
  return {
    ...net,
    nodes,
    edges: { ...net.edges, v_in: mk('v_in', 'nw', 'v', 'v_out'), v_out: mk('v_out', 'v', 'nw', 'v_in') },
  }
}

function projet(network: Network): Project {
  return {
    format: PROJECT_FORMAT, version: PROJECT_VERSION,
    meta: {
      id: 'test', name: 'Test', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      center: { lon: 4, lat: 45 }, attribution: ATTRIBUTION,
    },
    network, demand: defaultDemand(network), settings: DEFAULT_SETTINGS, changes: [],
  }
}

describe('fusion de nœuds sur un carrefour à feux', () => {
  it('complète le plan au lieu de laisser des mouvements au rouge', () => {
    const net = avecBrancheVoisine(withSignals(crossNetwork()))
    const store = createAppStore({ createClient: clientInerte, persist: false })
    const s = () => store.getState()
    s().loadProject(projet(net))

    s().mergeNodes('v', 'c')

    const apres = s().project!.network
    const c = apres.controllers.c1
    const adj = buildAdjacency(apres)
    const couverts = new Set<string>()
    for (const p of c.phases) for (const k of Object.keys(p.movements)) couverts.add(k)
    const jamais = controllerMovements(apres, c, adj).filter((m) => !couverts.has(m.key))

    expect(jamais).toEqual([])
    expect(validateController(apres, c, adj).some((a) => /jamais au vert/.test(a))).toBe(false)
  })

  it('journalise la complétion pour que l’utilisateur en soit informé', () => {
    const net = avecBrancheVoisine(withSignals(crossNetwork()))
    const store = createAppStore({ createClient: clientInerte, persist: false })
    const s = () => store.getState()
    s().loadProject(projet(net))
    s().mergeNodes('v', 'c')

    const dernier = s().project!.changes.at(-1)!
    expect(dernier.label).toMatch(/plan de feux complété : \d+ mouvements?/)
  })

  it('reste annulable : annuler restaure le plan d’origine', () => {
    const net = avecBrancheVoisine(withSignals(crossNetwork()))
    const store = createAppStore({ createClient: clientInerte, persist: false })
    const s = () => store.getState()
    s().loadProject(projet(net))
    const avant = JSON.stringify(s().project!.network.controllers.c1)

    s().mergeNodes('v', 'c')
    expect(JSON.stringify(s().project!.network.controllers.c1)).not.toBe(avant)

    s().undo()
    expect(JSON.stringify(s().project!.network.controllers.c1)).toBe(avant)
  })

  it('ne modifie rien quand la topologie change loin de tout carrefour à feux', () => {
    const net = avecBrancheVoisine(withSignals(crossNetwork()))
    const store = createAppStore({ createClient: clientInerte, persist: false })
    const s = () => store.getState()
    s().loadProject(projet(net))
    const avant = s().project!.network.controllers.c1

    s().updateEdge('v_in', { maxspeed: 30 })

    expect(s().project!.network.controllers.c1).toBe(avant)
    expect(s().project!.changes.at(-1)!.label).not.toMatch(/plan de feux complété/)
  })
})

describe('ouverture d’un projet dont le plan de feux est incomplet', () => {
  it('rattache les mouvements orphelins et le consigne dans le journal', () => {
    const net = withSignals(crossNetwork())
    const c = net.controllers.c1
    // Projet enregistré avant le correctif : une seule phase, un seul mouvement.
    const casse: Network = {
      ...net,
      controllers: {
        c1: { ...c, phases: [{ ...c.phases[0], movements: { [Object.keys(c.phases[0].movements)[0]]: 'protected' as const } }] },
      },
    }
    const store = createAppStore({ createClient: clientInerte, persist: false })
    const s = () => store.getState()
    s().loadProject(projet(casse))

    const charge = s().project!
    const repare = charge.network.controllers.c1
    const couverts = new Set<string>()
    for (const p of repare.phases) for (const k of Object.keys(p.movements)) couverts.add(k)
    const jamais = controllerMovements(charge.network, repare, buildAdjacency(charge.network))
      .filter((m) => !couverts.has(m.key))
    expect(jamais).toEqual([])
    expect(charge.changes.at(-1)!.label).toMatch(/Plan de feux complété à l’ouverture/)
    // L'ouverture ne compte pas comme une modification à annuler.
    expect(s().canUndo).toBe(false)
  })

  it('n’ajoute aucune entrée au journal quand les plans sont déjà complets', () => {
    const store = createAppStore({ createClient: clientInerte, persist: false })
    const s = () => store.getState()
    s().loadProject(projet(withSignals(crossNetwork())))
    expect(s().project!.changes).toEqual([])
  })
})
