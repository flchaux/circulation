import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { controllerCycle } from '@/model/signals'
import { DEFAULT_MAXSPEED } from '@/model/defaults'
import type { NetEdge } from '@/model/types'
import { osm2graph } from './osm2graph'
import { createProjection } from './projection'
import type { CommuneDetail, OsmElement, OsmExtract, OsmNode, OsmRelation, OsmWay } from './types'

/* ------------------------------------------------------------------ */
/*  Fabrique d'extraits synthétiques                                   */
/*  Le plan est décrit en mètres locaux ; les nœuds sont reprojetés en */
/*  degrés pour que l'import refasse exactement le chemin inverse.     */
/* ------------------------------------------------------------------ */

const CENTRE = { lon: 4, lat: 45 }
const projection = createProjection(CENTRE)

function node(id: number, x: number, y: number, tags?: Record<string, string>): OsmNode {
  const { lon, lat } = projection.toLonLat(x, y)
  return tags ? { type: 'node', id, lon, lat, tags } : { type: 'node', id, lon, lat }
}

function way(id: number, nodes: number[], tags: Record<string, string>): OsmWay {
  return { type: 'way', id, nodes, tags }
}

function restriction(id: number, from: number, via: number, to: number, kind: string): OsmRelation {
  return {
    type: 'relation',
    id,
    members: [
      { type: 'way', ref: from, role: 'from' },
      { type: 'node', ref: via, role: 'via' },
      { type: 'way', ref: to, role: 'to' },
    ],
    tags: { type: 'restriction', restriction: kind },
  }
}

/** Contour carré de demi-côté `half` mètres autour du centre. */
function squareContour(half: number): CommuneDetail['contour'] {
  const corners: [number, number][] = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
    [-half, -half],
  ]
  return {
    type: 'Polygon',
    coordinates: [
      corners.map(([x, y]) => {
        const { lon, lat } = projection.toLonLat(x, y)
        return [lon, lat] as [number, number]
      }),
    ],
  }
}

function buildExtract(elements: OsmElement[], half: number): OsmExtract {
  return {
    format: 'circulation-osm-extract',
    version: 1,
    extractedAt: '2026-09-04T00:00:00.000Z',
    attribution: 'test',
    commune: {
      nom: 'Bourg-d’Essai',
      code: '99999',
      codesPostaux: ['99999'],
      centre: { type: 'Point', coordinates: [CENTRE.lon, CENTRE.lat] },
      population: 1234,
      surface: 256,
      contour: squareContour(half),
    },
    osm: { elements },
  }
}

/* ------------------------------------------------------------------ */
/*  Plan de test principal (demi-côté 800 m)                           */
/*                                                                     */
/*   n1 ──── n3 ══ n4 ═ n5 ════ n6 ⟳ n8 ──── n18       (est-ouest)     */
/*   (bord)   │    feux feux     giratoire    (bord)                   */
/*            │     │     │           │                                */
/*           n11───n13   n15         n20                               */
/* ------------------------------------------------------------------ */

const PLAN: OsmElement[] = [
  // Axe est-ouest
  node(1, -1000, 0), //          hors contour → nœud frontière
  node(2, -500, 0), //           simple point de géométrie
  node(3, -200, 0), //           carrefour avec le sens unique
  node(4, 0, 0, { highway: 'traffic_signals' }),
  node(5, 25, 0, { highway: 'traffic_signals' }),
  node(6, 480, 0), //            entrée du giratoire
  // Giratoire
  node(7, 500, 20),
  node(8, 520, 0),
  node(9, 500, -20),
  // Sens unique n3 → n11
  node(10, -200, 150),
  node(11, 0, 150),
  // Rue du Nord n4 → n11 → n13
  node(12, 0, 130, { highway: 'stop', direction: 'forward' }),
  node(13, 0, 1000),
  // Avenue du Midi n5 → n15
  node(14, 25, -150),
  node(15, 25, -1000),
  // Route de l'Est n8 → n18
  node(16, 540, 0, { highway: 'give_way', direction: 'backward' }),
  node(17, 700, 0),
  node(18, 1000, 0),
  // Route du Sud n9 → n20
  node(19, 500, -400),
  node(20, 500, -1000),
  // Route de la Boucle : sort puis rentre dans le contour
  node(21, -600, 600),
  node(22, -600, 900),
  node(23, -300, 900),
  node(24, -300, 600),
  node(25, -300, 400),
  // Impasse sans lien avec la frontière
  node(26, 300, 400),
  node(27, 350, 450),
  // Ways écartés par le filtrage
  node(28, -700, -600),
  node(29, -650, -600),
  node(30, 600, 600),
  node(31, 650, 600),
  node(32, -100, -600),
  node(33, -50, -600),
  // Antenne accessible aux véhicules malgré access=private
  node(36, -100, 400),
  // Way dont un nœud manque à l'extrait
  node(40, 700, -700),

  way(101, [1, 2, 3, 4, 5, 6], { highway: 'residential', name: 'Rue Principale', lanes: '3', maxspeed: '50' }),
  way(102, [3, 10, 11], { highway: 'residential', name: 'Rue du Sens Unique', oneway: 'yes', lanes: '1' }),
  way(103, [4, 12, 11, 13], { highway: 'residential', name: 'Rue du Nord' }),
  way(104, [5, 14, 15], { highway: 'residential', name: 'Avenue du Midi', 'source:maxspeed': 'FR:zone30' }),
  way(105, [6, 7, 8, 9, 6], { highway: 'residential', junction: 'roundabout', name: 'Giratoire des Tilleuls' }),
  way(106, [8, 16, 17, 18], { highway: 'residential', name: "Route de l'Est" }),
  way(107, [9, 19, 20], { highway: 'residential', name: 'Route du Sud', maxspeed: '30 mph' }),
  way(108, [21, 22, 23, 24, 25], { highway: 'living_street', name: 'Route de la Boucle' }),
  way(109, [26, 27], { highway: 'residential', name: 'Impasse Perdue' }),
  way(110, [28, 29], { highway: 'residential', access: 'private', name: 'Allée Privée' }),
  way(111, [30, 31], { highway: 'residential', area: 'yes', name: 'Place pavée' }),
  way(112, [32, 33], { highway: 'footway', name: 'Sentier' }),
  way(113, [25, 36], { highway: 'residential', access: 'private', motor_vehicle: 'yes', name: 'Desserte des Prés' }),
  way(114, [40, 41], { highway: 'residential', name: 'Way tronqué' }),

  restriction(201, 101, 3, 101, 'only_straight_on'),
  restriction(202, 102, 11, 103, 'no_left_turn'),
]

const plan = osm2graph(buildExtract(PLAN, 800))

/** Tronçon attendu (échoue explicitement s'il manque). */
function edge(id: string): NetEdge {
  const e = plan.network.edges[id]
  expect(e, `tronçon ${id} attendu`).toBeDefined()
  return e
}

describe('osm2graph — extrait synthétique', () => {
  it('produit les statistiques attendues', () => {
    expect(plan.stats).toEqual({
      ways: 10, // 14 ways lus, moins footway, area=yes, access=private et le way tronqué
      edges: 28,
      nodes: 17,
      entries: 7,
      exits: 7,
      signals: 2,
      controllers: 1,
      stops: 1,
      giveWays: 1,
      restrictions: 2,
      droppedEdges: 2,
      warnings: 2, // way tronqué + composante isolée
    })
    expect(plan.warnings).toHaveLength(2)
  })

  it('écarte les ways non routiers, privés ou tronqués', () => {
    const wayIds = new Set(Object.values(plan.network.edges).map((e) => e.osmWayId))
    expect(wayIds.has(110)).toBe(false) // access=private
    expect(wayIds.has(111)).toBe(false) // area=yes
    expect(wayIds.has(112)).toBe(false) // highway=footway
    expect(wayIds.has(114)).toBe(false) // nœud absent de l'extrait
    expect(wayIds.has(113)).toBe(true) // access=private mais motor_vehicle=yes
    expect(plan.warnings.some((w) => w.includes('nœuds sont absents'))).toBe(true)
  })

  it('crée deux tronçons liés pour une rue à double sens et simplifie les points intermédiaires', () => {
    const aller = edge('e101_0')
    const retour = edge('e101_0r')
    expect(aller.from).toBe('n1')
    expect(aller.to).toBe('n3')
    expect(retour.from).toBe('n3')
    expect(retour.to).toBe('n1')
    expect(aller.reverseOf).toBe('e101_0r')
    expect(retour.reverseOf).toBe('e101_0')
    // n2 n'est ni partagé ni extrémité : il reste un simple point de géométrie.
    expect(plan.network.nodes.n2).toBeUndefined()
    expect(aller.geometry).toEqual([
      [-1000, 0],
      [-500, 0],
      [-200, 0],
    ])
    expect(retour.geometry).toEqual([...aller.geometry].reverse())
    expect(aller.length).toBeCloseTo(800, 2)
    expect(retour.length).toBeCloseTo(800, 2)
    // lanes=3 sur une rue à double sens : ⌈3/2⌉ à l'aller, ⌊3/2⌋ au retour.
    expect(aller.lanes).toBe(2)
    expect(retour.lanes).toBe(1)
    expect(aller.maxspeed).toBe(50)
    expect(aller.estimated).toEqual({ lanes: false, maxspeed: false })
  })

  it('ne crée qu’un tronçon pour un sens unique', () => {
    const unique = edge('e102_0')
    expect(unique.from).toBe('n3')
    expect(unique.to).toBe('n11')
    expect(unique.reverseOf).toBeUndefined()
    expect(plan.network.edges.e102_0r).toBeUndefined()
    expect(unique.geometry).toEqual([
      [-200, 0],
      [-200, 150],
      [0, 150],
    ])
    expect(unique.length).toBeCloseTo(350, 2)
    expect(unique.lanes).toBe(1)
    expect(unique.estimated).toEqual({ lanes: false, maxspeed: true })
    expect(unique.maxspeed).toBe(DEFAULT_MAXSPEED.residential)
  })

  it('interprète les vitesses implicites et impériales', () => {
    expect(edge('e104_0').maxspeed).toBe(30) // source:maxspeed=FR:zone30
    expect(edge('e104_0').estimated.maxspeed).toBe(false)
    expect(edge('e107_0').maxspeed).toBe(48) // 30 mph
    expect(edge('e108_0').maxspeed).toBe(20) // living_street sans tag
    expect(edge('e108_0').estimated.maxspeed).toBe(true)
  })

  it('découpe le giratoire en tronçons circulaires à sens unique', () => {
    const anneau = Object.values(plan.network.edges).filter((e) => e.osmWayId === 105)
    expect(anneau).toHaveLength(3)
    for (const e of anneau) {
      expect(e.roundabout).toBe(true)
      expect(e.reverseOf).toBeUndefined()
    }
    // L'anneau boucle : n6 → n8 → n9 → n6.
    const suivant = new Map(anneau.map((e) => [e.from, e.to]))
    expect(suivant.get('n6')).toBe('n8')
    expect(suivant.get('n8')).toBe('n9')
    expect(suivant.get('n9')).toBe('n6')
  })

  it('rattache un stop directionnel à la seule approche concernée', () => {
    const control = plan.network.controls.n11
    expect(control).toEqual({ nodeId: 'n11', type: 'stop', yieldEdges: ['e103_0'] })
    // Le stop porte direction=forward : le sens opposé n'est pas concerné.
    expect(edge('e103_0').to).toBe('n11')
    expect(plan.network.controls.n4).not.toMatchObject({ type: 'stop' })
  })

  it('rattache un cédez-le-passage direction=backward au carrefour amont', () => {
    const control = plan.network.controls.n8
    expect(control?.type).toBe('give_way')
    expect(control?.yieldEdges).toEqual(['e106_0r'])
    expect(edge('e106_0r').from).toBe('n18')
    expect(edge('e106_0r').to).toBe('n8')
  })

  it('regroupe deux nœuds de feux distants de moins de 30 m en un contrôleur', () => {
    expect(Object.keys(plan.network.controllers)).toEqual(['c4'])
    const controller = plan.network.controllers.c4
    expect(new Set(controller.nodeIds)).toEqual(new Set(['n4', 'n5']))
    expect(plan.network.controls.n4).toEqual({ nodeId: 'n4', type: 'signals', controllerId: 'c4' })
    expect(plan.network.controls.n5).toEqual({ nodeId: 'n5', type: 'signals', controllerId: 'c4' })
    expect(controller.mode).toBe('fixed')
    expect(controller.phases.length).toBeGreaterThanOrEqual(1)
    expect(controllerCycle(controller)).toBeGreaterThan(0)
    // Les tronçons internes au regroupement ne sont jamais pilotés.
    const pilotees = new Set(controller.phases.flatMap((p) => Object.keys(p.movements)).map((k) => k.split('>')[0]))
    expect(pilotees.has('e101_2')).toBe(false)
    expect(pilotees.has('e101_2r')).toBe(false)
    expect(pilotees.has('e101_1')).toBe(true)
  })

  it('applique une restriction only_straight_on en interdisant les autres sorties', () => {
    // Depuis n1, tout droit vers n4 : la seule autre sortie de n3 est le sens unique.
    expect(edge('e101_0').bannedTo).toEqual(['e102_0'])
    // Le demi-tour reste géré par nodeMovements() et n'est pas listé.
    expect(edge('e101_0').bannedTo).not.toContain('e101_0r')
  })

  it('applique une restriction no_left_turn sur la bonne sortie', () => {
    expect(edge('e102_0').bannedTo).toEqual(['e103_1'])
    expect(edge('e103_1').from).toBe('n11')
    expect(edge('e103_1').to).toBe('n13')
  })

  it('découpe en deux suites un way qui traverse deux fois la frontière', () => {
    const boucle = Object.values(plan.network.edges).filter((e) => e.osmWayId === 108)
    expect(boucle).toHaveLength(4)
    expect(new Set(boucle.map((e) => e.id))).toEqual(new Set(['e108_0', 'e108_0r', 'e108_1', 'e108_1r']))
    // Le premier nœud extérieur de chaque côté devient un nœud frontière, coordonnées conservées.
    expect(plan.network.nodes.n22.boundary).toBe(true)
    expect(plan.network.nodes.n23.boundary).toBe(true)
    expect(plan.network.nodes.n21.boundary).toBe(false)
    expect(plan.network.nodes.n25.boundary).toBe(false)
    expect([plan.network.nodes.n22.x, plan.network.nodes.n22.y]).toEqual([-600, 900])
    // n24 est intérieur à la seconde suite : il n'est pas topologique.
    expect(plan.network.nodes.n24).toBeUndefined()
  })

  it('supprime les composantes sans accès à la frontière', () => {
    expect(Object.values(plan.network.edges).some((e) => e.osmWayId === 109)).toBe(false)
    expect(plan.network.nodes.n26).toBeUndefined()
    expect(plan.stats.droppedEdges).toBe(2)
    expect(plan.warnings.some((w) => w.includes('isolé'))).toBe(true)
  })

  it('nomme les nœuds d’après les rues concourantes', () => {
    expect(plan.network.nodes.n3.label).toBe('Rue Principale / Rue du Sens Unique')
    expect(plan.network.nodes.n1.label).toBe('Rue Principale')
  })

  it('garantit l’invariant de géométrie et de réciprocité', () => {
    for (const e of Object.values(plan.network.edges)) {
      const from = plan.network.nodes[e.from]
      const to = plan.network.nodes[e.to]
      expect(from, `nœud amont de ${e.id}`).toBeDefined()
      expect(to, `nœud aval de ${e.id}`).toBeDefined()
      expect(e.geometry[0]).toEqual([from.x, from.y])
      expect(e.geometry[e.geometry.length - 1]).toEqual([to.x, to.y])
      expect(e.length).toBeGreaterThan(0)
      if (e.reverseOf) {
        expect(plan.network.edges[e.reverseOf].reverseOf).toBe(e.id)
        expect(plan.network.edges[e.reverseOf].from).toBe(e.to)
      }
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Stop sans sens indiqué et stop=all                                 */
/* ------------------------------------------------------------------ */

function croisement(stopTags: Record<string, string>): OsmExtract {
  return buildExtract(
    [
      node(1, -800, 0),
      node(2, 0, 0),
      node(3, 800, 0),
      node(4, 0, -800),
      node(6, 0, -30, stopTags),
      way(201, [1, 2, 3], { highway: 'residential', name: 'Rue Est-Ouest' }),
      way(202, [4, 6, 2], { highway: 'residential', name: 'Rue du Sud' }),
    ],
    500,
  )
}

describe('osm2graph — rattachement automatique des stops', () => {
  it('choisit le carrefour le plus proche quand aucun sens n’est indiqué', () => {
    const { network } = osm2graph(croisement({ highway: 'stop' }))
    // Le carrefour n2 est à 30 m, le bord n4 à 770 m : seul le sens montant est concerné.
    expect(network.controls.n2).toEqual({ nodeId: 'n2', type: 'stop', yieldEdges: ['e202_0'] })
    expect(network.edges.e202_0.to).toBe('n2')
    expect(network.controls.n4).toBeUndefined()
  })

  it('applique stop=all à toutes les approches du carrefour', () => {
    const { network } = osm2graph(croisement({ highway: 'stop', stop: 'all' }))
    const control = network.controls.n2
    expect(control?.type).toBe('stop')
    expect(new Set(control?.yieldEdges)).toEqual(new Set(['e201_0', 'e201_1r', 'e202_0']))
    for (const id of control?.yieldEdges ?? []) expect(network.edges[id].to).toBe('n2')
  })
})

/* ------------------------------------------------------------------ */
/*  Extrait réel : Veauche (42323)                                     */
/* ------------------------------------------------------------------ */

describe('osm2graph — extrait réel de Veauche', () => {
  const extract = JSON.parse(readFileSync('public/demo/veauche.osm.json', 'utf8')) as OsmExtract
  const started = performance.now()
  const result = osm2graph(extract)
  const elapsedMs = performance.now() - started

  it('importe le réseau en moins d’une seconde', () => {
    expect(elapsedMs).toBeLessThan(1000)
  })

  it('produit un réseau de taille réaliste', () => {
    expect(result.stats.edges).toBeGreaterThan(800)
    expect(result.stats.entries).toBeGreaterThan(5)
    expect(result.stats.exits).toBeGreaterThan(5)
    expect(result.stats.nodes).toBeGreaterThan(300)
    expect(result.stats.edges).toBe(Object.keys(result.network.edges).length)
    expect(result.stats.nodes).toBe(Object.keys(result.network.nodes).length)
  })

  it('traite les 13 relations de restriction de l’extrait', () => {
    const relations = extract.osm.elements.filter(
      (el) => el.type === 'relation' && el.tags?.type === 'restriction',
    )
    expect(relations).toHaveLength(13)
    expect(result.stats.restrictions).toBe(13)
    // Les interdictions appliquées désignent toujours une sortie réelle du carrefour aval.
    for (const e of Object.values(result.network.edges)) {
      for (const banned of e.bannedTo) {
        expect(result.network.edges[banned], `${e.id} interdit ${banned}`).toBeDefined()
        expect(result.network.edges[banned].from).toBe(e.to)
      }
    }
    expect(Object.values(result.network.edges).some((e) => e.bannedTo.length > 0)).toBe(true)
  })

  it('ne produit aucun tronçon de longueur nulle', () => {
    for (const e of Object.values(result.network.edges)) {
      expect(e.length, e.id).toBeGreaterThan(0)
      expect(e.geometry.length).toBeGreaterThanOrEqual(2)
      expect(e.lanes).toBeGreaterThanOrEqual(1)
      expect(e.maxspeed).toBeGreaterThan(0)
    }
  })

  it('maintient reverseOf symétrique et des géométries cohérentes', () => {
    for (const e of Object.values(result.network.edges)) {
      const from = result.network.nodes[e.from]
      const to = result.network.nodes[e.to]
      expect(from, `nœud amont de ${e.id}`).toBeDefined()
      expect(to, `nœud aval de ${e.id}`).toBeDefined()
      expect(e.geometry[0]).toEqual([from.x, from.y])
      expect(e.geometry[e.geometry.length - 1]).toEqual([to.x, to.y])
      if (e.reverseOf) {
        const rev = result.network.edges[e.reverseOf]
        expect(rev, `inverse de ${e.id}`).toBeDefined()
        expect(rev.reverseOf).toBe(e.id)
        expect(rev.from).toBe(e.to)
        expect(rev.to).toBe(e.from)
        expect(rev.geometry).toEqual([...e.geometry].reverse())
      }
    }
  })

  it('rattache les stops et cédez-le-passage à des approches valides', () => {
    expect(result.stats.stops).toBeGreaterThan(10)
    expect(result.stats.giveWays).toBeGreaterThan(0)
    for (const control of Object.values(result.network.controls)) {
      expect(result.network.nodes[control.nodeId], control.nodeId).toBeDefined()
      for (const id of control.yieldEdges ?? []) {
        expect(result.network.edges[id], id).toBeDefined()
        expect(result.network.edges[id].to).toBe(control.nodeId)
      }
    }
  })

  it('conserve un graphe entièrement relié à la frontière', () => {
    const nodes = Object.values(result.network.nodes)
    const boundary = nodes.filter((n) => n.boundary)
    // Toute entrée et toute sortie est portée par un nœud frontière.
    expect(boundary.length).toBeGreaterThanOrEqual(Math.max(result.stats.entries, result.stats.exits))
    expect(boundary.length).toBe(29) // extrait figé de Veauche
    const degree = new Map<string, number>()
    for (const e of Object.values(result.network.edges)) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
    }
    for (const n of nodes) expect(degree.get(n.id), `nœud isolé ${n.id}`).toBeGreaterThan(0)
  })
})
