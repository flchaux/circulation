/**
 * Rattachement manuel d'un dossier de carrefour (docs/ARCHITECTURE.md §14.3).
 *
 * Le cas reproduit est celui du dossier VE006 de Veauche, « Jourcey / Avenue de la Libération » :
 * OpenStreetMap découpe ce carrefour en deux nœuds distants d'une trentaine de mètres, l'un portant
 * « Avenue de la Libération / Rue de Jourcey », l'autre « Rue de la Guillonnière / Avenue de la
 * Libération ». Aucun ne porte les trois voies du dossier, les deux reconnaissent autant de voies l'un
 * que l'autre : l'importeur refuse à juste titre de deviner, et c'est à l'exploitant de trancher.
 *
 * Le réseau est synthétique — seuls les noms de rues sont ceux de Veauche — pour que le test ne dépende
 * ni d'un extrait OpenStreetMap ni d'un fichier hors du dépôt.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, defaultDemand } from '@/model/defaults'
import type { NetEdge, NetNode, Network, Project } from '@/model/types'
import { PROJECT_FORMAT, PROJECT_VERSION } from '@/model/types'
import { createAppStore } from './store'
import type { AppState } from './storeTypes'

/* ------------------------------------------------------------------ */
/*  Réseau et dossier de test                                          */
/* ------------------------------------------------------------------ */

function node(id: string, x: number, y: number, boundary = false, label?: string): NetNode {
  return label ? { id, x, y, boundary, label } : { id, x, y, boundary }
}

function twoWay(edges: Record<string, NetEdge>, a: NetNode, b: NetNode, name: string): void {
  const mk = (id: string, from: NetNode, to: NetNode, reverseOf: string): NetEdge => ({
    id,
    from: from.id,
    to: to.id,
    reverseOf,
    name,
    highway: 'secondary',
    lanes: 1,
    maxspeed: 50,
    length: Math.hypot(to.x - from.x, to.y - from.y),
    geometry: [[from.x, from.y], [to.x, to.y]],
    roundabout: false,
    closed: false,
    bannedTo: [],
    estimated: { lanes: false, maxspeed: false },
  })
  edges[`${a.id}${b.id}`] = mk(`${a.id}${b.id}`, a, b, `${b.id}${a.id}`)
  edges[`${b.id}${a.id}`] = mk(`${b.id}${a.id}`, b, a, `${a.id}${b.id}`)
}

const LIBERATION = 'Avenue de la Libération'
const JOURCEY = 'Rue de Jourcey'
const GUILLONNIERE = 'Rue de la Guillonnière'

/**
 * Les deux moitiés du carrefour VE006 : `nJourcey` et `nGuillonniere` sur l'Avenue de la Libération,
 * chacune avec sa rue transversale. Trois branches chacune, comme un vrai carrefour en T.
 */
function reseauVe006(): Network {
  const ouest = node('nOuest', -300, 0, true)
  const jourcey = node('nJourcey', 0, 0, false, `${LIBERATION} / ${JOURCEY}`)
  const guillonniere = node('nGuillonniere', 30, 0, false, `${LIBERATION} / ${GUILLONNIERE}`)
  const est = node('nEst', 330, 0, true)
  const brancheJourcey = node('nBrancheJourcey', 0, 150, true)
  const brancheGuillonniere = node('nBrancheGuillonniere', 30, -150, true)
  const nodes: Record<string, NetNode> = {}
  for (const n of [ouest, jourcey, guillonniere, est, brancheJourcey, brancheGuillonniere]) nodes[n.id] = n
  const edges: Record<string, NetEdge> = {}
  twoWay(edges, ouest, jourcey, LIBERATION)
  twoWay(edges, jourcey, guillonniere, LIBERATION)
  twoWay(edges, guillonniere, est, LIBERATION)
  twoWay(edges, jourcey, brancheJourcey, JOURCEY)
  twoWay(edges, guillonniere, brancheGuillonniere, GUILLONNIERE)
  return { nodes, edges, controls: {}, controllers: {} }
}

/** Deux carrefours portant exactement les mêmes deux rues : leurs libellés ne les distinguent pas. */
function reseauLibellesIdentiques(): Network {
  const label = 'Rue du Gabion / Avenue Paccard'
  const ouest = node('nO', -200, 0, true)
  const g1 = node('nG1', 0, 0, false, label)
  const g2 = node('nG2', 120, 0, false, label)
  const est = node('nE', 320, 0, true)
  const nord1 = node('nN1', 0, 120, true)
  const nord2 = node('nN2', 120, 120, true)
  const nodes: Record<string, NetNode> = {}
  for (const n of [ouest, g1, g2, est, nord1, nord2]) nodes[n.id] = n
  const edges: Record<string, NetEdge> = {}
  twoWay(edges, ouest, g1, 'Rue du Gabion')
  twoWay(edges, g1, g2, 'Rue du Gabion')
  twoWay(edges, g2, est, 'Rue du Gabion')
  twoWay(edges, g1, nord1, 'Avenue Paccard')
  twoWay(edges, g2, nord2, 'Avenue Paccard')
  return { nodes, edges, controls: {}, controllers: {} }
}

/** Dossier VE006 réduit à ce que le simulateur reprend : groupes, phases, plan, calendrier, inter-verts. */
const DOSSIER_VE006 = {
  id: 'VE006',
  nom: 'Jourcey / Avenue de la Libération',
  voies: [`${LIBERATION} (D1082)`, JOURCEY, GUILLONNIERE],
  groupes: [
    { id: 'V1', type: 'vehicule', voie: 'Voiture La Guillonnière' },
    { id: 'P2', type: 'pieton', voie: 'Piéton La Guillonnière' },
    { id: 'V3', type: 'vehicule', voie: 'Voiture Av. Libération (arrivée ouest)' },
    { id: 'P4', type: 'pieton', voie: 'Piéton Av. Libération (côté ouest)' },
    { id: 'V5', type: 'vehicule', voie: 'Voiture Jourcey' },
    { id: 'P6', type: 'pieton', voie: 'Piéton Jourcey' },
  ],
  phases: [
    { nom: 'Phase A Repos', vehicules: ['V3'], pietons: ['P2', 'P6'], mini_s: 15, maxi_s: 40 },
    { nom: 'Phase B', vehicules: ['V1', 'V5'], pietons: ['P4'], mini_s: 6, maxi_s: 21 },
  ],
  plans_de_feux: [
    {
      nom: 'PF1',
      periode: 'toute la journée',
      cycle_s: 70,
      phases: [
        { nom: 'Phase A Repos', mini_s: 15, maxi_s: 40 },
        { nom: 'Phase B', mini_s: 6, maxi_s: 21 },
      ],
    },
  ],
  calendrier: {
    lundi_a_vendredi: [{ plage: '00h00 - 24h00', plan: 'PF1' }],
  },
  matrice_inter_verts: {
    convention: 'Ligne = groupe qui perd le vert, colonne = groupe qui prend le vert.',
    groupes: ['V1', 'P2', 'V3', 'P4', 'V5', 'P6'],
    valeurs: {
      V1: { P4: 5, V3: 6 },
      P2: { V1: 8, V5: 8 },
      V3: { V1: 6, P2: 5, V5: 6, P6: 5 },
      P4: { V3: 10 },
      V5: { P4: 5, V3: 6 },
      P6: { V1: 8, V5: 8 },
    },
    valeur_jaune_s: { vehicules: 3 },
  },
  /* Ce qui suit relève du matériel : l'import doit l'ignorer sans se plaindre. */
  inventaire_materiel: { marque_controleur: 'Bouygues', armoire: { cartes_puissance: 4 } },
  malvoyants: { marque: 'Okeenea' },
}

function fichier(dossiers: unknown[]): string {
  return JSON.stringify({ commune: 'Veauche', nombre_dossiers: dossiers.length, carrefours: dossiers })
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

function setup(network: Network = reseauVe006()) {
  const store = createAppStore({ persist: false, createClient: () => ({ send: () => {}, dispose: () => {} }) })
  store.getState().loadProject(makeProject(network))
  return { store, s: (): AppState => store.getState() }
}

/* ------------------------------------------------------------------ */

describe('dossiers laissés de côté par l’import', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => { ctx = setup() })

  it('conserve le dossier, ses voies, sa raison et ses carrefours candidats', () => {
    const { s } = ctx
    const bilan = s().importDossiersFeux(fichier([DOSSIER_VE006]))
    expect(bilan.matches).toBe(0)
    expect(bilan.nonRattaches).toBe(1)

    const attente = s().dossiersNonRattaches
    expect(attente).toHaveLength(1)
    expect(attente[0].dossierId).toBe('VE006')
    expect(attente[0].nom).toBe('Jourcey / Avenue de la Libération')
    // Les voies sont celles de l'entête du dossier, dans son orthographe : ni découpées, ni normalisées,
    // ni noyées sous les « arrivée nord » et « côté ouest » que portent les libellés de groupes.
    expect(attente[0].voies).toEqual([`${LIBERATION} (D1082)`, JOURCEY, GUILLONNIERE])
    expect(attente[0].raison).toMatch(/correspondent aussi bien/)
    // Les deux moitiés du carrefour sont proposées, nommées par leurs rues et non par leur identifiant.
    expect(attente[0].candidats.map((c) => c.nodeId).sort()).toEqual(['nGuillonniere', 'nJourcey'])
    for (const candidat of attente[0].candidats) expect(candidat.etiquette).toContain(LIBERATION)
    expect(attente[0].candidats.map((c) => c.etiquette).join(' ')).toContain(JOURCEY)

    // Aucun carrefour n'a été modifié : l'importeur n'a rien deviné.
    expect(Object.keys(s().project?.network.controllers ?? {})).toHaveLength(0)
  })

  it('garde le bilan lisible après coup, sans le remettre au chargement d’un autre projet', () => {
    const { store, s } = ctx
    const bilan = s().importDossiersFeux(fichier([DOSSIER_VE006]))
    // Changer d'onglet démonte le panneau Feux : le bilan doit survivre dans le store.
    expect(s().dossiersRapport).toEqual(bilan)
    store.getState().loadProject(makeProject(reseauVe006()))
    expect(s().dossiersRapport).toBeNull()
    expect(s().dossiersNonRattaches).toEqual([])
  })

  it('numérote les carrefours candidats qui portent les mêmes rues', () => {
    const { s } = setup(reseauLibellesIdentiques())
    s().importDossiersFeux(fichier([{
      id: 'Place de l’Europe',
      nom: 'Place de l’Europe',
      voies_plan: ['Rue du Gabion', 'Avenue Paccard', 'Place de l’Europe'],
      groupes: [{ id: 'V1', type: 'vehicule', voie: 'Rue du Gabion' }],
    }]))
    const candidats = s().dossiersNonRattaches[0].candidats
    expect(candidats).toHaveLength(2)
    expect(candidats.map((c) => c.etiquette)).toEqual([
      'Rue du Gabion / Avenue Paccard (n° 1)',
      'Rue du Gabion / Avenue Paccard (n° 2)',
    ])
  })

  it('retire de la liste un carrefour candidat supprimé du réseau', () => {
    const { s } = ctx
    s().importDossiersFeux(fichier([DOSSIER_VE006]))
    s().deleteNode('nJourcey')
    expect(s().dossiersNonRattaches[0].candidats.map((c) => c.nodeId)).toEqual(['nGuillonniere'])
  })
})

describe('rattacherDossier', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
    ctx.s().importDossiersFeux(fichier([DOSSIER_VE006]))
  })

  it('applique au carrefour choisi le contrôleur du dossier, avec ses plans et sa matrice', () => {
    const { s } = ctx
    s().rattacherDossier('VE006', 'nJourcey')

    const network = s().project?.network
    const control = network?.controls.nJourcey
    expect(control?.type).toBe('signals')
    const controller = network?.controllers[control?.controllerId ?? '']
    expect(controller).toBeDefined()
    expect(controller?.source).toContain('VE006')
    expect(controller?.nodeIds).toEqual(['nJourcey'])
    expect(controller?.groups?.map((g) => g.id)).toEqual(['V1', 'P2', 'V3', 'P4', 'V5', 'P6'])
    expect(controller?.phases.map((p) => p.name)).toEqual(['Phase A Repos', 'Phase B'])
    expect(controller?.plans?.map((p) => p.name)).toEqual(['PF1'])
    expect(controller?.schedule?.length).toBeGreaterThan(0)
    expect(controller?.interGreen?.V3?.P2).toBe(5)
    expect(controller?.amberByGroup?.V1).toBe(3)
    // Le matériel du dossier ne doit pas entrer dans le modèle.
    expect(JSON.stringify(controller)).not.toContain('Bouygues')

    // L'autre moitié du carrefour n'a pas été touchée.
    expect(network?.controls.nGuillonniere).toBeUndefined()
    // Le dossier est traité : il sort de la liste d'attente et son carrefour devient la sélection.
    expect(s().dossiersNonRattaches).toEqual([])
    expect(s().selection).toEqual({ kind: 'controller', id: controller?.id })
    expect(s().dossiersRapport?.matches).toBe(1)
    expect(s().dossiersRapport?.nonRattaches).toBe(0)
  })

  it('rattache les groupes aux mouvements du carrefour choisi, et pas à ceux de l’autre', () => {
    const { store, s } = ctx
    s().rattacherDossier('VE006', 'nJourcey')
    const surJourcey = Object.values(s().project?.network.controllers ?? {})[0]
    // Au carrefour de Jourcey, le groupe « Voiture Jourcey » commande de vrais mouvements ; celui de la
    // Guillonnière, dont la rue est ailleurs, n'en commande aucun.
    expect(surJourcey.groups?.find((g) => g.id === 'V5')?.movements.length).toBeGreaterThan(0)
    expect(surJourcey.groups?.find((g) => g.id === 'V1')?.movements).toEqual([])

    store.getState().loadProject(makeProject(reseauVe006()))
    s().importDossiersFeux(fichier([DOSSIER_VE006]))
    s().rattacherDossier('VE006', 'nGuillonniere')
    const surGuillonniere = Object.values(s().project?.network.controllers ?? {})[0]
    expect(surGuillonniere.groups?.find((g) => g.id === 'V1')?.movements.length).toBeGreaterThan(0)
    expect(surGuillonniere.groups?.find((g) => g.id === 'V5')?.movements).toEqual([])
  })

  it('est annulable', () => {
    const { s } = ctx
    const avant = s().project?.network
    const changesAvant = s().project?.changes.length ?? 0
    s().rattacherDossier('VE006', 'nGuillonniere')
    expect(s().canUndo).toBe(true)
    expect(s().project?.changes).toHaveLength(changesAvant + 1)
    expect(s().project?.network).not.toEqual(avant)

    s().undo()
    expect(s().project?.network).toEqual(avant)
    expect(s().canRedo).toBe(true)
    s().redo()
    expect(s().project?.network.controls.nGuillonniere?.type).toBe('signals')
  })

  it('refuse un dossier inconnu ou un carrefour disparu, sans rien changer', () => {
    const { s } = ctx
    const avant = s().project?.network
    s().rattacherDossier('VE999', 'nJourcey')
    expect(s().project?.network).toBe(avant)
    expect(s().error).toBeNull()

    s().rattacherDossier('VE006', 'nInexistant')
    expect(s().project?.network).toBe(avant)
    expect(s().error).toMatch(/n’existe plus/)
    expect(s().dossiersNonRattaches).toHaveLength(1)
  })

  it('refuse un carrefour que le dossier ne décrit pas, plutôt que d’y poser un plan vide', () => {
    const { s } = setup()
    // Un dossier d'une autre commune : aucune de ses voies ne se retrouve au carrefour visé.
    s().importDossiersFeux(fichier([{
      id: 'AILLEURS',
      nom: 'Carrefour d’une autre commune',
      voies: ['Rue de Nulle Part', 'Avenue Introuvable'],
      groupes: [{ id: 'V1', type: 'vehicule', voie: 'Rue de Nulle Part' }],
      phases: [{ nom: 'Phase A', vehicules: ['V1'], mini_s: 10, maxi_s: 30 }],
    }]))
    expect(s().dossiersNonRattaches[0].candidats).toEqual([])
    const avant = s().project?.network
    s().rattacherDossier('AILLEURS', 'nJourcey')
    expect(s().project?.network).toBe(avant)
    expect(s().error).toMatch(/ne décrit rien/)
    // Le dossier reste en attente : l'exploitant peut viser un autre carrefour.
    expect(s().dossiersNonRattaches).toHaveLength(1)
  })

  it('remplace un contrôleur déjà en place au carrefour au lieu d’en ajouter un second', () => {
    const { s } = ctx
    s().setNodeControl('nJourcey', { type: 'signals' })
    const avant = s().project?.network.controls.nJourcey?.controllerId
    expect(avant).toBeDefined()
    s().rattacherDossier('VE006', 'nJourcey')
    expect(Object.keys(s().project?.network.controllers ?? {})).toHaveLength(1)
    expect(s().project?.network.controllers[avant ?? '']?.source).toContain('VE006')
  })
})

describe('détachement d’un dossier (resetControllerPlan)', () => {
  it('rend le carrefour au plan par défaut, données de dossier comprises', () => {
    const { s } = setup()
    s().importDossiersFeux(fichier([DOSSIER_VE006]))
    s().rattacherDossier('VE006', 'nJourcey')
    const controllerId = s().project?.network.controls.nJourcey?.controllerId ?? ''
    expect(s().project?.network.controllers[controllerId].plans?.length).toBeGreaterThan(0)
    // Un plan imposé depuis l'interface porte sur un plan du dossier : il doit disparaître avec lui.
    const planId = s().project?.network.controllers[controllerId].plans?.[0].id ?? ''
    s().setActivePlan(controllerId, planId)
    expect(s().ui.planApercu[controllerId]).toBe(planId)

    s().resetControllerPlan(controllerId)
    const controller = s().project?.network.controllers[controllerId]
    expect(controller?.phases[0].name).toBe('Axe principal')
    expect(controller?.groups).toBeUndefined()
    expect(controller?.interGreen).toBeUndefined()
    expect(controller?.amberByGroup).toBeUndefined()
    expect(controller?.plans).toBeUndefined()
    expect(controller?.schedule).toBeUndefined()
    expect(controller?.source).toBeUndefined()
    expect(s().ui.planApercu[controllerId]).toBeUndefined()
    // Le carrefour reste à feux : détacher un dossier n'est pas supprimer la signalisation.
    expect(s().project?.network.controls.nJourcey?.type).toBe('signals')

    s().undo()
    expect(s().project?.network.controllers[controllerId].source).toContain('VE006')
  })
})
