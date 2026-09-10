/**
 * Pose d'un nœud libre : transformation pure, action du store, outil de carte.
 *
 * L'enjeu de ces tests n'est pas la création elle-même — deux lignes — mais la survie du nœud posé :
 * un nœud sans aucun tronçon est un cas que ni l'import OpenStreetMap ni l'éditeur ne produisaient
 * jusqu'ici. Il traverse `sanitizeNetwork`, `reconcileDemand`, l'export/import JSON, l'historique et le
 * moteur ; chacun de ces passages est vérifié ici, faute de quoi le nœud disparaîtrait entre deux
 * manipulations sans que rien ne le signale à l'utilisateur.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Demand, NetEdge, NetNode, Network, Project, SimResults } from '@/model/types'
import { PROJECT_FORMAT, PROJECT_VERSION } from '@/model/types'
import { DEFAULT_SETTINGS, defaultDemand, reconcileDemand } from '@/model/defaults'
import { validateProject } from '@/model/schema'
import { generateArrivals } from '@/engine/demand'
import { Simulation } from '@/engine/simulation'
import { MapRenderer, NODE_ZOOM, type MapScene, type RendererView } from '@/ui/map/renderer'
import { mapClickAction } from '@/ui/map/MapView'
import { S } from '@/ui/strings'
import { addNode, nextNodeId, sanitizeNetwork } from './edits'

// `MapView` importe Leaflet, qui réclame un `window` dès son chargement. Ces tests n'affichent pas de
// carte : ils n'examinent que la décision de clic, exportée du composant ; un module factice suffit.
vi.mock('leaflet', () => ({ default: {} }))

import { createAppStore } from './store'
import type { AppState } from './storeTypes'

/* ------------------------------------------------------------------ */
/*  Fabriques                                                          */
/* ------------------------------------------------------------------ */

function noeud(id: string, x: number, y: number, boundary = false): NetNode {
  return { id, x, y, boundary }
}

function troncon(id: string, from: NetNode, to: NetNode, extra: Partial<NetEdge> = {}): NetEdge {
  return {
    id,
    from: from.id,
    to: to.id,
    highway: 'residential',
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

/** Rue à double sens entre deux nœuds : tronçons `<a><b>` et `<b><a>`. */
function double(edges: Record<string, NetEdge>, a: NetNode, b: NetNode): void {
  edges[`${a.id}${b.id}`] = troncon(`${a.id}${b.id}`, a, b, { reverseOf: `${b.id}${a.id}` })
  edges[`${b.id}${a.id}`] = troncon(`${b.id}${a.id}`, b, a, { reverseOf: `${a.id}${b.id}` })
}

/** Rue traversante : nW (frontière) — n1 — nE (frontière), double sens. */
function corridor(): Network {
  const ouest = noeud('n11', -200, 0, true)
  const centre = noeud('n12', 0, 0)
  const est = noeud('n13', 200, 0, true)
  const nodes = { n11: ouest, n12: centre, n13: est }
  const edges: Record<string, NetEdge> = {}
  double(edges, ouest, centre)
  double(edges, centre, est)
  return { nodes, edges, controls: {}, controllers: {} }
}

function projet(network: Network): Project {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    meta: {
      id: 'test', name: 'Projet de test', createdAt: at, updatedAt: at,
      center: { lon: 4.29, lat: 45.5616 }, attribution: 'test',
    },
    network,
    demand: defaultDemand(network),
    settings: { ...DEFAULT_SETTINGS },
    changes: [],
  }
}

function setup(network: Network = corridor()) {
  const store = createAppStore({ persist: false })
  store.getState().loadProject(projet(network))
  return { store, s: (): AppState => store.getState() }
}

/* ------------------------------------------------------------------ */
/*  1. Transformation pure                                             */
/* ------------------------------------------------------------------ */

describe('addNode : pose d’un nœud libre', () => {
  it('pose un nœud isolé, hors frontière, aux coordonnées arrondies au centimètre', () => {
    const avant = corridor()
    const apres = addNode(avant, 12.3456, -7.891)
    const pose = apres.nodes.x1

    expect(pose).toEqual({ id: 'x1', x: 12.35, y: -7.89, boundary: false })
    // Ni entrée ni sortie du réseau : `boundary` faux, et aucun tronçon ne le touche.
    expect(pose.boundary).toBe(false)
    expect(Object.values(apres.edges).some((e) => e.from === 'x1' || e.to === 'x1')).toBe(false)
    // Immuabilité : le réseau reçu n'est pas modifié, les objets inchangés gardent leur identité.
    expect(avant.nodes.x1).toBeUndefined()
    expect(apres.edges).toBe(avant.edges)
    expect(apres.nodes.n12).toBe(avant.nodes.n12)
  })

  it('reprend le libellé fourni, une fois débarrassé de ses espaces', () => {
    expect(addNode(corridor(), 0, 0, '  Entrée du lotissement ').nodes.x1.label).toBe('Entrée du lotissement')
    // Un libellé vide ne crée pas de champ : le modèle laisse `label` absent plutôt que vide.
    expect(addNode(corridor(), 0, 0, '   ').nodes.x1.label).toBeUndefined()
  })

  it('numérote x1, x2… sans jamais heurter un identifiant OpenStreetMap', () => {
    const reseau = corridor()
    expect(nextNodeId(reseau)).toBe('x1')
    const un = addNode(reseau, 10, 10)
    const deux = addNode(un, 20, 20)
    expect(Object.keys(deux.nodes).filter((id) => id.startsWith('x'))).toEqual(['x1', 'x2'])
    // Les nœuds OSM sont `n{osmId}` : le préfixe `x` leur est étranger, aucune collision possible.
    expect(Object.keys(deux.nodes).some((id) => /^n\d+$/.test(id) && id.startsWith('x'))).toBe(false)
  })

  it('reprend la numérotation au-dessus du plus grand x{k} déjà posé', () => {
    const reseau = corridor()
    reseau.nodes.x7 = noeud('x7', 5, 5)
    expect(nextNodeId(reseau)).toBe('x8')
    expect(addNode(reseau, 1, 1).nodes.x8).toBeDefined()
    // La numérotation des nœuds est indépendante de celle des tronçons (`x{k}` dans `edges`).
    reseau.edges.x9 = troncon('x9', reseau.nodes.n11, reseau.nodes.n12)
    expect(nextNodeId(reseau)).toBe('x8')
  })

  it('refuse des coordonnées non finies plutôt que de créer un nœud indessinable', () => {
    const reseau = corridor()
    expect(addNode(reseau, Number.NaN, 0)).toBe(reseau)
    expect(addNode(reseau, 0, Number.POSITIVE_INFINITY)).toBe(reseau)
  })
})

/* ------------------------------------------------------------------ */
/*  2. Survie du nœud isolé                                            */
/* ------------------------------------------------------------------ */

describe('un nœud isolé survit aux traitements du réseau', () => {
  it('sanitizeNetwork le conserve, y compris quand elle nettoie le reste', () => {
    const reseau = addNode(corridor(), 40, 60)
    expect(sanitizeNetwork(reseau).nodes.x1).toBeDefined()

    // Même passage, mais avec du ménage à faire : un tronçon dont une extrémité a disparu. Le nœud
    // isolé ne doit pas être emporté avec lui sous prétexte qu'il ne porte aucun tronçon.
    const orphelin: Network = {
      ...reseau,
      edges: { ...reseau.edges, mort: troncon('mort', noeud('fantome', 9, 9), reseau.nodes.n12) },
    }
    const assaini = sanitizeNetwork(orphelin)
    expect(assaini.edges.mort).toBeUndefined()
    expect(assaini.nodes.x1).toEqual({ id: 'x1', x: 40, y: 60, boundary: false })
  })

  it('reconcileDemand ne lui crée ni entrée ni sortie', () => {
    const base = corridor()
    const demande = defaultDemand(base)
    const apres = reconcileDemand(addNode(base, 40, 60), demande)

    expect(apres.entries.x1).toBeUndefined()
    expect(apres.exits.x1).toBeUndefined()
    expect(Object.keys(apres.entries)).toEqual(Object.keys(demande.entries))
    expect(Object.keys(apres.exits)).toEqual(Object.keys(demande.exits))
  })

  it('ne change rien aux arrivées générées (variables aléatoires communes)', () => {
    const base = corridor()
    const demande: Demand = { ...defaultDemand(base), globalFactor: 1 }
    const reglages = { ...DEFAULT_SETTINGS, durationMin: 10, warmupMin: 0 }
    const sans = generateArrivals(base, demande, reglages)
    const avec = generateArrivals(addNode(base, 40, 60), reconcileDemand(addNode(base, 40, 60), demande), reglages)

    expect(sans.length).toBeGreaterThan(0)
    expect(avec).toEqual(sans)
  })

  it('traverse un aller-retour export/import JSON', () => {
    const { store, s } = setup()
    s().addNode(31.5, -12.25, 'Accès chantier')
    const texte = s().exportProjectJson()

    const relu = validateProject(JSON.parse(texte))
    expect(relu.ok).toBe(true)

    store.getState().importProjectJson(texte)
    expect(s().error).toBeNull()
    expect(s().project?.network.nodes.x1).toEqual({ id: 'x1', x: 31.5, y: -12.25, boundary: false, label: 'Accès chantier' })
  })

  it('disparaît puis revient avec annuler / rétablir', () => {
    const { s } = setup()
    s().addNode(40, 60)
    expect(s().project?.network.nodes.x1).toBeDefined()
    expect(s().canUndo).toBe(true)

    s().undo()
    expect(s().project?.network.nodes.x1).toBeUndefined()
    // La sélection portait sur le nœud disparu : elle est purgée (invariant du store).
    expect(s().selection).toBeNull()

    s().redo()
    expect(s().project?.network.nodes.x1).toEqual({ id: 'x1', x: 40, y: 60, boundary: false })
  })
})

/* ------------------------------------------------------------------ */
/*  3. Action du store                                                 */
/* ------------------------------------------------------------------ */

describe('store : pose d’un nœud', () => {
  it('sélectionne le nœud posé pour le rendre modifiable sans le rechercher', () => {
    const { s } = setup()
    s().addNode(40, 60)
    expect(s().selection).toEqual({ kind: 'node', id: 'x1' })
    expect(s().project?.changes.at(-1)?.label).toBe("Pose d'un nœud")
    expect(s().sim.stale).toBe(true)
  })

  it('ne pose rien et ne consomme pas d’historique sur des coordonnées non finies', () => {
    const { s } = setup()
    s().addNode(Number.NaN, 60)
    expect(s().canUndo).toBe(false)
    expect(s().project?.changes).toEqual([])
  })

  it('le nœud posé est aussitôt déplaçable, raccordable, fusionnable et supprimable', () => {
    const { s } = setup()
    s().addNode(0, 120)

    // Déplacement (glisser).
    s().beginNodeDrag('x1')
    s().dragNode('x1', 10, 130)
    s().endNodeDrag('x1')
    expect(s().project?.network.nodes.x1).toMatchObject({ x: 10, y: 130 })

    // Raccordement à un nœud existant : c'est ce qui le fait exister pour la simulation.
    s().addEdge('x1', 'n12', { twoWay: true, highway: 'residential', lanes: 1, maxspeed: 50 })
    const relies = Object.values(s().project!.network.edges).filter((e) => e.from === 'x1' || e.to === 'x1')
    expect(relies).toHaveLength(2)
    expect(relies.every((e) => e.geometry[0][0] === s().project!.network.nodes[e.from].x)).toBe(true)

    // Suppression : le nœud et ses tronçons partent ensemble.
    s().deleteNode('x1')
    expect(s().project?.network.nodes.x1).toBeUndefined()
    expect(Object.values(s().project!.network.edges).some((e) => e.from === 'x1' || e.to === 'x1')).toBe(false)
  })

  it('raccordé au réseau, il n’ouvre ni entrée ni sortie : ce n’est pas un point de frontière', () => {
    const { s } = setup()
    s().addNode(0, 120)
    s().addEdge('x1', 'n12', { twoWay: true, highway: 'residential', lanes: 1, maxspeed: 50 })

    // `reconcileDemand` crée une entrée/sortie pour tout nœud frontière portant un tronçon : le nœud
    // posé n'en est pas un, la demande ne bouge donc pas et le trafic le traverse au lieu de s'y arrêter.
    expect(s().project?.demand.entries.x1).toBeUndefined()
    expect(s().project?.demand.exits.x1).toBeUndefined()
    expect(Object.keys(s().project!.demand.entries).sort()).toEqual(['n11', 'n13'])
    expect(Object.keys(s().project!.demand.exits).sort()).toEqual(['n11', 'n13'])
  })

  it('se fusionne dans un nœud existant comme n’importe quel nœud', () => {
    const { s } = setup()
    s().addNode(5, 5)
    s().addEdge('x1', 'n12', { twoWay: false, highway: 'residential', lanes: 1, maxspeed: 50 })
    s().mergeNodes('x1', 'n11')

    expect(s().project?.network.nodes.x1).toBeUndefined()
    expect(Object.values(s().project!.network.edges).some((e) => e.from === 'n11' && e.to === 'n12')).toBe(true)
  })

  it('numérote le second nœud posé x2', () => {
    const { s } = setup()
    s().addNode(10, 10)
    s().addNode(20, 20)
    expect(s().selection).toEqual({ kind: 'node', id: 'x2' })
    expect(s().project?.network.nodes.x2).toMatchObject({ x: 20, y: 20 })
  })
})

/* ------------------------------------------------------------------ */
/*  4. Moteur                                                          */
/* ------------------------------------------------------------------ */

describe('simulation', () => {
  /** Résultats d'une exécution complète, hors champs dépendant du réseau lui-même. */
  function simuler(network: Network): SimResults {
    const demand: Demand = reconcileDemand(network, defaultDemand(network))
    const settings = { ...DEFAULT_SETTINGS, durationMin: 10, warmupMin: 1, dynamicRouting: false, statsIntervalMin: 5 }
    const sim = new Simulation({ network, demand, settings })
    let garde = 100_000
    while (!sim.done && garde-- > 0) sim.step(200)
    expect(sim.done).toBe(true)
    return sim.results()
  }

  it('un nœud isolé ne change rien aux résultats', () => {
    const base = corridor()
    const avecNoeud = addNode(base, 60, 80)

    const sans = simuler(base)
    const avec = simuler(avecNoeud)

    expect(sans.network.entered).toBeGreaterThan(0)
    expect(avec.network).toEqual(sans.network)
    expect(avec.edges).toEqual(sans.edges)
    expect(avec.exits).toEqual(sans.exits)
    expect(avec.series).toEqual(sans.series)
    expect(avec.warnings).toEqual(sans.warnings)
    // Le nœud isolé n'est pas un carrefour : il n'apparaît pas dans les indicateurs par carrefour.
    expect(Object.keys(avec.intersections)).toEqual(Object.keys(sans.intersections))
    expect(avec.intersections.x1).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/*  5. Rendu de la carte                                               */
/* ------------------------------------------------------------------ */

interface AppelCanvas { methode: string; args: unknown[]; fillStyle: unknown }

/** Contexte 2D factice : enregistre les appels de dessin (le dépôt n'embarque aucun canvas réel). */
function contexteFactice(): { ctx: CanvasRenderingContext2D; appels: AppelCanvas[] } {
  const appels: AppelCanvas[] = []
  const proprietes: Record<string, unknown> = {}
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_cible, nom) {
      if (typeof nom !== 'string') return undefined
      if (nom in proprietes) return proprietes[nom]
      if (nom === 'measureText') return (texte: string) => ({ width: texte.length * 6 })
      return (...args: unknown[]) => { appels.push({ methode: nom, args, fillStyle: proprietes.fillStyle }) }
    },
    set(_cible, nom, valeur) {
      if (typeof nom === 'string') proprietes[nom] = valeur
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, appels }
}

function scene(network: Network): MapScene {
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
    tool: 'addNode',
    itineraires: null,
    toolNodes: [],
    toolPath: [],
    frame: null,
    edgeIndex: [],
  }
}

/** Cadrage centré : 1 m = 1 px, le nœud (0, 0) tombe au milieu du canvas. */
const VUE: RendererView = {
  zoom: NODE_ZOOM, originX: 0, originY: 0, offsetX: 0, offsetY: 0, width: 400, height: 300,
  pxPerMeter: 1, project: (x, y) => [200 + x, 150 - y],
}

describe('rendu de la carte', () => {
  it('dessine un nœud isolé, avant qu’il ne porte le moindre tronçon', () => {
    const statique = contexteFactice()
    const renderer = new MapRenderer(statique.ctx, contexteFactice().ctx)
    renderer.setView(VUE)

    const reseau = addNode({ nodes: {}, edges: {}, controls: {}, controllers: {} }, 0, 0)
    renderer.drawStatic(scene(reseau))

    // Un nœud ordinaire est un petit disque : c'est le seul arc dessiné sur un réseau sans tronçon.
    const arcs = statique.appels.filter((a) => a.methode === 'arc')
    expect(arcs).toHaveLength(1)
    expect(arcs[0].args.slice(0, 3)).toEqual([200, 150, 2.4])
    expect(statique.appels.some((a) => a.methode === 'fill')).toBe(true)
  })

  it('le sélectionne au clic : le test de sélection le retrouve sans tronçon', () => {
    const renderer = new MapRenderer(contexteFactice().ctx, contexteFactice().ctx)
    renderer.setView(VUE)
    const reseau = addNode({ nodes: {}, edges: {}, controls: {}, controllers: {} }, 25, -10)

    expect(renderer.hitTest(reseau, 225, 160, 8)).toEqual({ kind: 'node', id: 'x1' })
    expect(renderer.hitTest(reseau, 100, 100, 8)).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/*  6. Outil de carte et libellés                                      */
/* ------------------------------------------------------------------ */

describe('outil « poser un nœud » sur la carte', () => {
  it('pose un nœud sur un clic n’importe où, là où les autres outils exigent un nœud', () => {
    // Hors de tout élément : seul `addNode` agit.
    expect(mapClickAction('addNode', null)).toEqual({ kind: 'addNode' })
    expect(mapClickAction('addEdge', null)).toEqual({ kind: 'none' })
    expect(mapClickAction('greenwave', null)).toEqual({ kind: 'none' })
    // Sur un tronçon : idem, le nœud est posé par-dessus la voie sans y être raccordé.
    expect(mapClickAction('addNode', { kind: 'edge', id: 'e1' })).toEqual({ kind: 'addNode' })
    expect(mapClickAction('addEdge', { kind: 'edge', id: 'e1' })).toEqual({ kind: 'none' })
  })

  it('ne casse ni l’onde verte ni l’ajout de tronçon, qui restent des outils à deux clics de nœud', () => {
    expect(mapClickAction('addEdge', { kind: 'node', id: 'n12' })).toEqual({ kind: 'toolNode', nodeId: 'n12' })
    expect(mapClickAction('greenwave', { kind: 'node', id: 'n12' })).toEqual({ kind: 'toolNode', nodeId: 'n12' })
  })

  it('sélectionne un nœud existant au lieu d’en empiler un second au même endroit', () => {
    expect(mapClickAction('addNode', { kind: 'node', id: 'n12' })).toEqual({
      kind: 'select', selection: { kind: 'node', id: 'n12' },
    })
  })

  it('laisse l’outil de sélection intact', () => {
    expect(mapClickAction('select', { kind: 'edge', id: 'e1' })).toEqual({
      kind: 'select', selection: { kind: 'edge', id: 'e1' },
    })
    expect(mapClickAction('select', null)).toEqual({ kind: 'select', selection: null })
  })
})

describe('libellés de l’outil', () => {
  const PANNEAU = readFileSync('src/ui/panels/ReseauPanel.tsx', 'utf8')
  const CARTE = readFileSync('src/ui/map/MapView.tsx', 'utf8')
  const STYLES = readFileSync('src/styles.css', 'utf8')

  it('le panneau Réseau propose l’outil et affiche son aide', () => {
    expect(PANNEAU).toContain("setTool('addNode')")
    expect(PANNEAU).toContain('S.reseau.outilNoeud}')
    expect(PANNEAU).toContain('S.reseau.outilNoeudAide')
    expect(PANNEAU).toContain('S.reseau.outilNoeudAideRaccord')
  })

  it('l’aide dit que le nœud posé ne sert à rien tant qu’il n’est pas relié, et comment le relier', () => {
    const aide = `${S.reseau.outilNoeudAide} ${S.reseau.outilNoeudAideRaccord}`
    expect(aide).toMatch(/tant qu’aucun tronçon n’y aboutit/)
    expect(aide).toContain(S.reseau.outilAjout)
    expect(aide).toMatch(/cliquez ce nœud puis celui à joindre/)
    // Le vocabulaire reste celui de la voirie : ni « vertex », ni « point », ni anglicisme.
    expect(aide).not.toMatch(/vertex|node\b|point d’arrêt/i)
  })

  it('la carte annonce l’outil actif et pose le nœud aux coordonnées du clic', () => {
    expect(S.carte.outilPoseNoeudActif).toMatch(/^Pose d’un nœud/)
    expect(CARTE).toContain('state.addNode(x, y)')
    expect(CARTE).toContain('const [x, y] = toLocal(point)')
    // Le curseur en croix distingue un outil qui vise un emplacement d'un outil qui vise un objet.
    expect(CARTE).toContain("'crosshair'")
  })

  it('le sélecteur d’outils tient dans le panneau : la grille utilisée est bien définie', () => {
    expect(PANNEAU).toContain('segmented--grille')
    expect(STYLES).toContain('.segmented--grille {')
  })
})
