/**
 * Outil « itinéraires » : les cinq chemins les plus courts entre deux nœuds, du clic sur la carte à
 * l'aperçu affiché par le panneau Réseau et surligné par la carte.
 *
 * Ce que ces tests protègent, au-delà du calcul (couvert par `src/engine/itineraires.test.ts`) : un
 * aperçu qui survivrait à une modification du réseau ferait lire des temps qui ne valent plus, sur des
 * tronçons peut-être fermés ou disparus.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { DEFAULT_SETTINGS, defaultDemand } from '@/model/defaults'
import type { NetEdge, NetNode, Network, Project } from '@/model/types'
import { PROJECT_FORMAT, PROJECT_VERSION } from '@/model/types'
import { createAppStore } from './store'

function node(id: string, x: number, y: number, boundary = false): NetNode {
  return { id, x, y, boundary }
}

/** Damier 3 × 3 de rues à double sens espacées de 100 m : plusieurs itinéraires d'un coin à l'autre. */
function damier(): Network {
  const nodes: Record<string, NetNode> = {}
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) nodes[`r${r}c${c}`] = node(`r${r}c${c}`, c * 100, -r * 100)
  }
  const edges: Record<string, NetEdge> = {}
  const relier = (a: string, b: string): void => {
    for (const [from, to] of [[a, b], [b, a]]) {
      edges[`${from}>${to}`] = {
        id: `${from}>${to}`, from, to, reverseOf: `${to}>${from}`, name: `${a}–${b}`,
        highway: 'residential', lanes: 1, maxspeed: 50, length: 100,
        geometry: [[nodes[from].x, nodes[from].y], [nodes[to].x, nodes[to].y]],
        roundabout: false, closed: false, bannedTo: [], estimated: { lanes: false, maxspeed: false },
      }
    }
  }
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (c + 1 < 3) relier(`r${r}c${c}`, `r${r}c${c + 1}`)
      if (r + 1 < 3) relier(`r${r}c${c}`, `r${r + 1}c${c}`)
    }
  }
  return { nodes, edges, controls: {}, controllers: {} }
}

function makeProject(network: Network): Project {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    meta: { id: 'test', name: 'Projet de test', createdAt: at, updatedAt: at, center: { lon: 4.29, lat: 45.5616 }, attribution: 'test' },
    network,
    demand: defaultDemand(network),
    settings: { ...DEFAULT_SETTINGS },
    changes: [],
  }
}

function setup(network: Network = damier()) {
  const store = createAppStore({ persist: false })
  store.getState().loadProject(makeProject(network))
  return store
}

describe('outil itinéraires', () => {
  it('calcule les cinq itinéraires au second clic de nœud et vide les nœuds de l’outil', () => {
    const store = setup()
    store.getState().setTool('itineraires')
    store.getState().toolClickNode('r0c0')
    expect(store.getState().ui.itineraires).toBeNull()
    expect(store.getState().ui.toolNodes).toEqual(['r0c0'])

    store.getState().toolClickNode('r2c2')
    const apercu = store.getState().ui.itineraires!
    expect(store.getState().ui.toolNodes).toEqual([])
    expect(apercu.from).toBe('r0c0')
    expect(apercu.to).toBe('r2c2')
    expect(apercu.chemins).toHaveLength(5)
    expect(apercu.perime).toBe(false)
    expect(apercu.actif).toBe(-1)
    // L'outil reste actif : on compare volontiers plusieurs couples de nœuds à la suite.
    expect(store.getState().ui.tool).toBe('itineraires')
  })

  it('signale l’absence d’itinéraire au lieu d’afficher une liste vide sans explication', () => {
    const network = damier()
    // Le coin d'arrivée n'est plus atteignable : ses deux accès sont fermés.
    for (const id of ['r1c2>r2c2', 'r2c1>r2c2']) network.edges[id] = { ...network.edges[id], closed: true }
    const store = setup(network)
    store.getState().calculerItineraires('r0c0', 'r2c2')
    expect(store.getState().ui.itineraires?.chemins).toEqual([])
    expect(store.getState().error).toMatch(/aucun itinéraire/i)
  })

  it('périme l’aperçu dès que le réseau change, et le recalcul le rétablit', () => {
    const store = setup()
    store.getState().calculerItineraires('r0c0', 'r2c2')
    const avant = store.getState().ui.itineraires!.chemins[0].time

    store.getState().updateEdge('r0c0>r0c1', { maxspeed: 10 })
    const perime = store.getState().ui.itineraires!
    expect(perime.perime).toBe(true)
    expect(perime.from).toBe('r0c0')

    store.getState().recalculerItineraires()
    const apres = store.getState().ui.itineraires!
    expect(apres.perime).toBe(false)
    expect(apres.chemins).toHaveLength(5)
    // Le premier itinéraire ne passe plus par la rue ralentie, ou met plus longtemps s'il y passe encore.
    if (apres.chemins[0].edges.includes('r0c0>r0c1')) expect(apres.chemins[0].time).toBeGreaterThan(avant)
    else expect(apres.chemins[0].edges).not.toContain('r0c0>r0c1')
  })

  it('oublie l’aperçu quand l’un des deux nœuds disparaît', () => {
    const store = setup()
    store.getState().calculerItineraires('r0c0', 'r2c2')
    expect(store.getState().ui.itineraires).not.toBeNull()
    store.getState().deleteNode('r2c2')
    expect(store.getState().ui.itineraires).toBeNull()
  })

  it('met un itinéraire en avant, borne les rangs hors liste et efface à la demande', () => {
    const store = setup()
    store.getState().calculerItineraires('r0c0', 'r2c2')
    store.getState().setItineraireActif(2)
    expect(store.getState().ui.itineraires?.actif).toBe(2)
    store.getState().setItineraireActif(99)
    expect(store.getState().ui.itineraires?.actif).toBe(-1)
    store.getState().effacerItineraires()
    expect(store.getState().ui.itineraires).toBeNull()
  })

  it('ne touche ni au projet, ni à l’historique, ni à la simulation', () => {
    const store = setup()
    const projet = store.getState().project
    store.getState().calculerItineraires('r0c0', 'r2c2')
    expect(store.getState().project).toBe(projet)
    expect(store.getState().canUndo).toBe(false)
    expect(store.getState().dirty).toBe(false)
  })

  it('compte le retard des carrefours du projet : un stop rallonge le temps annoncé', () => {
    const network = damier()
    const store = setup(network)
    store.getState().calculerItineraires('r0c0', 'r0c2')
    const sansStop = store.getState().ui.itineraires!.chemins[0].time

    store.getState().setNodeControl('r0c1', { type: 'stop' })
    store.getState().recalculerItineraires()
    const avecStop = store.getState().ui.itineraires!.chemins[0].time
    expect(avecStop).toBeGreaterThan(sansStop)
  })

  it('est proposé par le panneau Réseau et surligné par la carte', () => {
    const panneau = readFileSync('src/ui/panels/ReseauPanel.tsx', 'utf8')
    expect(panneau).toContain("setTool('itineraires')")
    expect(panneau).toContain('ItinerairesResultat')
    const renderer = readFileSync('src/ui/map/renderer.ts', 'utf8')
    expect(renderer).toContain('drawItineraires')
    const carte = readFileSync('src/ui/map/MapView.tsx', 'utf8')
    // Un aperçu périmé n'est pas dessiné : c'est la carte qui tranche, pas le renderer.
    expect(carte).toContain('state.ui.itineraires?.perime ? null : state.ui.itineraires')
  })
})
