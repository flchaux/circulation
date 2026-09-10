/**
 * Étiquettes de valeur de la carte : les deux sens d'une rue à double sens.
 *
 * Les deux tronçons d'une même rue sont dessinés à quelques pixels l'un de l'autre et portent chacun
 * leur propre chiffre. Tant qu'ils se disputaient une cellule de la grille d'occupation, seul l'un des
 * deux s'affichait, et lequel changeait avec le zoom et le déplacement de la carte : l'utilisateur ne
 * pouvait pas lire le sens montant et le sens descendant d'un même axe. Ces tests vérifient qu'une
 * seule étiquette porte désormais les deux valeurs, avec une flèche par sens, quel que soit le cadrage.
 */
import { describe, expect, it } from 'vitest'
import type { EdgeStats, NetEdge, NetNode, Network, SimResults } from '@/model/types'
import { LABEL_ZOOM, MapRenderer, firstHeading, type MapScene, type RendererView } from './renderer'
import type { ColorMode } from '@/state/storeTypes'

/* ------------------------------------------------------------------ */
/*  Contexte 2D factice et réseau de test                              */
/* ------------------------------------------------------------------ */

interface AppelCanvas { methode: string; args: unknown[] }

/** Contexte 2D factice : enregistre les appels de dessin (le dépôt n'embarque aucun canvas réel). */
function contexteFactice(): { ctx: CanvasRenderingContext2D; appels: AppelCanvas[] } {
  const appels: AppelCanvas[] = []
  const proprietes: Record<string, unknown> = {}
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_cible, nom) {
      if (typeof nom !== 'string') return undefined
      if (nom in proprietes) return proprietes[nom]
      if (nom === 'measureText') return (texte: string) => ({ width: texte.length * 6 })
      return (...args: unknown[]) => { appels.push({ methode: nom, args }) }
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

function troncon(id: string, from: NetNode, to: NetNode, extra: Partial<NetEdge> = {}): NetEdge {
  return {
    id,
    from: from.id,
    to: to.id,
    name: 'Avenue de la Libération',
    highway: 'secondary',
    lanes: 1,
    maxspeed: 50,
    length: Math.hypot(to.x - from.x, to.y - from.y),
    geometry: [[from.x, from.y], [to.x, to.y]],
    roundabout: false,
    closed: false,
    bannedTo: [],
    estimated: { lanes: false, maxspeed: false },
    ...extra,
  }
}

/** Rue est-ouest de 200 m à double sens, centrée sur l'origine. */
function rue(): Network {
  const ouest = noeud('o', -100, 0)
  const est = noeud('e', 100, 0)
  return {
    nodes: { o: ouest, e: est },
    edges: {
      oe: troncon('oe', ouest, est, { reverseOf: 'eo' }),
      eo: troncon('eo', est, ouest, { reverseOf: 'oe' }),
    },
    controls: {},
    controllers: {},
  }
}

function stats(flow: number): EdgeStats {
  return {
    entered: flow, exited: flow, flowVehH: flow, meanSpeedKmh: 40, meanTravelTimeS: 18,
    totalDelayS: 0, meanDelayS: 0, maxQueue: 0, meanQueue: 0, saturation: 0.3,
  }
}

/** Résultats réduits aux seules statistiques par tronçon dont les étiquettes ont besoin. */
function resultats(edges: Record<string, EdgeStats>): SimResults {
  return { edges } as unknown as SimResults
}

function scene(network: Network, results: SimResults | null, colorMode: ColorMode): MapScene {
  return {
    network,
    colorMode,
    results,
    reference: null,
    selection: null,
    hover: null,
    drag: null,
    showLabels: true,
    showVehicles: false,
    tool: 'select',
    itineraires: null,
    toolNodes: [],
    toolPath: [],
    frame: null,
    edgeIndex: [],
  }
}

/** Cadrage : 1 m = 1 px, l'origine du réseau au milieu du canvas, décalé de `origine` pixels. */
function vue(origine = 0): RendererView {
  return {
    zoom: LABEL_ZOOM,
    originX: origine,
    originY: origine,
    offsetX: 0,
    offsetY: 0,
    width: 400,
    height: 300,
    pxPerMeter: 1,
    project: (x, y) => [origine + 200 + x, origine + 150 - y],
  }
}

/** Textes écrits sur le canvas statique pour une scène donnée. */
function textes(scene: MapScene, view: RendererView): string[] {
  const statique = contexteFactice()
  const renderer = new MapRenderer(statique.ctx, contexteFactice().ctx)
  renderer.setView(view)
  renderer.drawStatic(scene)
  return statique.appels.filter((a) => a.methode === 'fillText').map((a) => String(a.args[0]))
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('étiquettes des deux sens d’un tronçon', () => {
  const reseau = rue()
  const res = resultats({ oe: stats(820), eo: stats(430) })

  it('affiche les deux débits dans une seule étiquette', () => {
    const ecrits = textes(scene(reseau, res, 'flow'), vue())

    expect(ecrits).toContain('820 véh/h')
    expect(ecrits).toContain('430 véh/h')
  })

  it('les affiche encore quel que soit le cadrage', () => {
    // La grille d'occupation est alignée sur les pixels du canvas : c'est ce décalage qui, autrefois,
    // faisait basculer d'un sens à l'autre au fil des zooms et des déplacements.
    for (const origine of [0, 3, 7, 8, 11, 16, 23, 40]) {
      const ecrits = textes(scene(reseau, res, 'flow'), vue(origine))
      expect(ecrits, `origine ${origine}`).toContain('820 véh/h')
      expect(ecrits, `origine ${origine}`).toContain('430 véh/h')
    }
  })

  it('dessine une flèche par sens, orientée le long de la rue', () => {
    const statique = contexteFactice()
    const renderer = new MapRenderer(statique.ctx, contexteFactice().ctx)
    renderer.setView(vue())
    renderer.drawStatic(scene(reseau, res, 'flow'))

    // Deux rotations de valeur opposée : la rue est est-ouest, un sens va vers 0 rad, l'autre vers π.
    const rotations = statique.appels.filter((a) => a.methode === 'rotate').map((a) => Number(a.args[0]))
    expect(rotations).toHaveLength(2)
    expect(Math.abs(Math.abs(rotations[0] - rotations[1]) - Math.PI)).toBeLessThan(1e-6)
  })

  it('n’écrit qu’une fois le nom de la rue, sans valeur à afficher', () => {
    const ecrits = textes(scene(reseau, null, 'class'), vue())

    expect(ecrits.filter((t) => t === 'Avenue de la Libération')).toHaveLength(1)
  })

  it('chiffre le seul sens mesuré quand l’autre n’a pas de valeur', () => {
    // Vitesse moyenne : un tronçon qu'aucun véhicule n'a quitté n'en a pas.
    const partiel = resultats({ oe: stats(820), eo: { ...stats(0), exited: 0 } })
    const ecrits = textes(scene(reseau, partiel, 'speed'), vue())

    expect(ecrits).toEqual(['40 km/h'])
  })

  it('garde l’étiquette simple et son trait de couleur sur un sens unique', () => {
    const sensUnique: Network = {
      ...reseau,
      edges: { oe: { ...reseau.edges.oe, reverseOf: undefined } },
    }
    const statique = contexteFactice()
    const renderer = new MapRenderer(statique.ctx, contexteFactice().ctx)
    renderer.setView(vue())
    renderer.drawStatic(scene(sensUnique, resultats({ oe: stats(820) }), 'flow'))

    const ecrits = statique.appels.filter((a) => a.methode === 'fillText').map((a) => String(a.args[0]))
    expect(ecrits).toEqual(['820 véh/h'])
    // Aucune flèche : le sens ne fait pas de doute, la couleur de l'échelle reste sous le chiffre.
    expect(statique.appels.some((a) => a.methode === 'rotate')).toBe(false)
    expect(statique.appels.some((a) => a.methode === 'fillRect' && a.args[3] === 2)).toBe(true)
  })

  it('écrit en premier le sens qui va vers la droite de l’écran', () => {
    const versLaDroite = { x: 0, y: 0, dx: 1, dy: 0 }
    const versLaGauche = { x: 0, y: 0, dx: -1, dy: 0 }
    const versLeHaut = { x: 0, y: 0, dx: 0, dy: -1 }
    const versLeBas = { x: 0, y: 0, dx: 0, dy: 1 }

    expect(firstHeading(versLaDroite, versLaGauche)).toBe(true)
    expect(firstHeading(versLaGauche, versLaDroite)).toBe(false)
    // Rue verticale : les deux sens ont le même `dx`, c'est celui qui monte qui est écrit en premier.
    expect(firstHeading(versLeHaut, versLeBas)).toBe(true)
    expect(firstHeading(versLeBas, versLeHaut)).toBe(false)
  })
})
