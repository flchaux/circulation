/**
 * Dessin des itinéraires comparés sur la carte.
 *
 * Ce que ces tests vérifient tient en une phrase : cinq itinéraires qui se recouvrent doivent rester
 * cinq itinéraires lisibles. Chacun a sa couleur, chacun porte son temps quelque part où il ne se
 * confond pas avec ses voisins, et l'itinéraire mis en avant passe devant les autres.
 */
import { describe, expect, it } from 'vitest'
import type { NetEdge, NetNode, Network } from '@/model/types'
import type { ApercuItineraires } from '@/state/storeTypes'
import type { Itineraire } from '@/engine/itineraires'
import { itineraireParPassage, itinerairesLesPlusCourts } from '@/engine/itineraires'
import { LABEL_ZOOM, MapRenderer, type MapScene, type RendererView } from './renderer'
import { itineraireColor } from './colors'

interface AppelCanvas { methode: string; args: unknown[]; couleur: unknown; trait: unknown; alpha: unknown }

/** Contexte 2D factice : enregistre les appels de dessin avec la couleur et l'opacité en vigueur. */
function contexteFactice(): { ctx: CanvasRenderingContext2D; appels: AppelCanvas[] } {
  const appels: AppelCanvas[] = []
  const proprietes: Record<string, unknown> = {}
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_cible, nom) {
      if (typeof nom !== 'string') return undefined
      if (nom in proprietes) return proprietes[nom]
      if (nom === 'measureText') return (texte: string) => ({ width: texte.length * 6 })
      return (...args: unknown[]) => {
        appels.push({
          methode: nom, args, couleur: proprietes.fillStyle, trait: proprietes.strokeStyle, alpha: proprietes.globalAlpha,
        })
      }
    },
    set(_cible, nom, valeur) {
      if (typeof nom === 'string') proprietes[nom] = valeur
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, appels }
}

function noeud(id: string, x: number, y: number): NetNode {
  return { id, x, y, boundary: false }
}

/** Damier 3 × 3 de 200 m de côté, rues à double sens : plusieurs itinéraires d'un coin à l'autre. */
function damier(): Network {
  const nodes: Record<string, NetNode> = {}
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) nodes[`r${r}c${c}`] = noeud(`r${r}c${c}`, c * 200 - 200, 200 - r * 200)
  }
  const edges: Record<string, NetEdge> = {}
  const relier = (a: string, b: string): void => {
    for (const [from, to] of [[a, b], [b, a]]) {
      edges[`${from}>${to}`] = {
        id: `${from}>${to}`, from, to, reverseOf: `${to}>${from}`, name: `${a}–${b}`,
        highway: 'residential', lanes: 1, maxspeed: 50, length: 200,
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

function apercu(network: Network, actif = -1): ApercuItineraires {
  const chemins: Itineraire[] = itinerairesLesPlusCourts(network, 'r0c0', 'r2c2')
  expect(chemins.length).toBe(5)
  return { from: 'r0c0', to: 'r2c2', chemins, perime: false, actif }
}

function scene(network: Network, itineraires: ApercuItineraires | null): MapScene {
  return {
    network,
    colorMode: 'class',
    results: null,
    reference: null,
    selection: null,
    hover: null,
    drag: null,
    showLabels: false,
    showVehicles: false,
    tool: 'itineraires',
    itineraires,
    toolNodes: [],
    toolPath: [],
    frame: null,
    edgeIndex: [],
  }
}

/** Cadrage : 1 m = 1 px, réseau centré dans un canvas de 900 × 900. */
function vue(): RendererView {
  return {
    zoom: LABEL_ZOOM,
    originX: 0,
    originY: 0,
    offsetX: 0,
    offsetY: 0,
    width: 900,
    height: 900,
    pxPerMeter: 1,
    project: (x, y) => [x + 450, 450 - y],
  }
}

function dessiner(itineraires: ApercuItineraires | null): AppelCanvas[] {
  const network = damier()
  const { ctx, appels } = contexteFactice()
  const autre = contexteFactice()
  const renderer = new MapRenderer(ctx, autre.ctx)
  renderer.setView(vue())
  renderer.drawStatic(scene(network, itineraires))
  return appels
}

/** Étiquettes de temps posées sur la carte, dans l'ordre de dessin. */
function etiquettes(appels: AppelCanvas[]): { texte: string; x: number; y: number; couleur: unknown; alpha: unknown }[] {
  return appels
    .filter((a) => a.methode === 'fillText')
    .map((a) => ({ texte: String(a.args[0]), x: Number(a.args[1]), y: Number(a.args[2]), couleur: a.couleur, alpha: a.alpha }))
}

describe('itinéraires sur la carte', () => {
  it('écrit le temps de chacun des cinq itinéraires, à sa couleur et à des endroits distincts', () => {
    const network = damier()
    const vue = apercu(network)
    const posees = etiquettes(dessiner(vue))
    expect(posees).toHaveLength(5)
    for (let rang = 0; rang < 5; rang++) {
      // « 1 · 1 min 26 s » : le rang, puis le temps total de l'itinéraire.
      expect(posees[rang].texte.startsWith(`${rang + 1} · `)).toBe(true)
      expect(posees[rang].texte).toMatch(/\d+\s*(s|min)/)
    }
    const emplacements = new Set(posees.map((e) => `${Math.round(e.x)},${Math.round(e.y)}`))
    expect(emplacements.size).toBe(5)
  })

  it('n’écrit rien quand aucun itinéraire n’est demandé', () => {
    expect(etiquettes(dessiner(null))).toHaveLength(0)
  })

  it('trace les rubans à la couleur de leur rang, du plus lent au plus rapide', () => {
    const network = damier()
    const appels = dessiner(apercu(network))
    const attendues = [0, 1, 2, 3, 4].map(itineraireColor)
    // Les cinq couleurs sont distinctes : sans cela, deux itinéraires seraient impossibles à départager.
    expect(new Set(attendues).size).toBe(5)
    // Suite des couleurs de trait employées, doublons consécutifs retirés (un ruban = un tronçon à la fois).
    const suite: string[] = []
    for (const appel of appels.filter((a) => a.methode === 'stroke')) {
      const trait = String(appel.trait)
      if (attendues.includes(trait) && suite[suite.length - 1] !== trait) suite.push(trait)
    }
    // Le plus lent d'abord, le meilleur en dernier : c'est lui qui reste visible là où tous se superposent.
    expect(suite).toEqual([...attendues].reverse())
  })

  it('marque d’un anneau le nœud imposé d’un itinéraire par point de passage', () => {
    const network = damier()
    const vue = apercu(network)
    const detour = itineraireParPassage(network, 'r0c0', 'r2c0', 'r2c2')!
    expect(detour.passage).toBe('r2c0')
    vue.chemins = [...vue.chemins, detour]

    const appels = dessiner(vue)
    // Le nœud r2c0 est en (−200 ; −200) m, soit (250 ; 650) px avec la projection de test.
    const anneaux = appels.filter((a) => a.methode === 'arc' && a.trait === itineraireColor(5))
    expect(anneaux).toHaveLength(1)
    expect(Math.round(Number(anneaux[0].args[0]))).toBe(250)
    expect(Math.round(Number(anneaux[0].args[1]))).toBe(650)

    // Aucun anneau pour les cinq itinéraires les plus courts : rien ne leur est imposé. (Les nœuds du
    // réseau sont eux aussi des arcs : on ne retient que ceux tracés à une couleur d'itinéraire.)
    const couleurs = [0, 1, 2, 3, 4, 5].map(itineraireColor)
    const sansPassage = dessiner(apercu(network)).filter((a) => a.methode === 'arc' && couleurs.includes(String(a.trait)))
    expect(sansPassage).toHaveLength(0)
  })

  it('estompe les autres itinéraires quand l’un d’eux est mis en avant', () => {
    const network = damier()
    const sansActif = etiquettes(dessiner(apercu(network, -1)))
    const avecActif = etiquettes(dessiner(apercu(network, 2)))
    expect(sansActif.every((e) => e.alpha === 1)).toBe(true)
    // L'itinéraire mis en avant est étiqueté le premier, en pleine opacité ; les autres sont estompés.
    expect(avecActif[0].texte.startsWith('3 · ')).toBe(true)
    expect(avecActif[0].alpha).toBe(1)
    expect(avecActif.slice(1).every((e) => Number(e.alpha) < 1)).toBe(true)
  })
})
