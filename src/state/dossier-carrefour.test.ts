/**
 * Import du dossier d'un carrefour depuis le store (docs/ARCHITECTURE.md §14).
 *
 * L'exploitant sélectionne le feu sur la carte, puis choisit le fichier de ce carrefour : le dossier
 * remplace le plan en place, sans que rien ne soit deviné. Le cas reproduit est celui du dossier VE006
 * de Veauche, « Jourcey / Avenue de la Libération » : OpenStreetMap découpe ce carrefour en deux nœuds
 * distants d'une trentaine de mètres, dont aucun ne porte les trois voies du dossier — c'est
 * précisément la situation où aucune reconnaissance automatique ne pouvait trancher.
 *
 * Le réseau est synthétique — seuls les noms de rues sont ceux de Veauche — pour que le test ne dépende
 * ni d'un extrait OpenStreetMap ni d'un fichier hors du dépôt.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, defaultDemand } from '@/model/defaults'
import type { ControllerId, NetEdge, NetNode, Network, Project } from '@/model/types'
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

/** Le fichier tel que la commune le livre : un carrefour, sous les métadonnées de la commune. */
function fichier(dossier: unknown): string {
  return JSON.stringify({ commune: 'Veauche', date_extraction: '2026-09-07', ...(dossier as object) })
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

/** Carrefour passé en feux par l'exploitant, prêt à recevoir son dossier. */
function feuSur(s: () => AppState, nodeId: string): ControllerId {
  s().setNodeControl(nodeId, { type: 'signals' })
  const controllerId = s().project?.network.controls[nodeId]?.controllerId
  if (!controllerId) throw new Error(`Le carrefour ${nodeId} n'est pas passé à feux`)
  return controllerId
}

describe('importDossierFeux', () => {
  it('applique le dossier au carrefour désigné, le journalise et reste annulable', () => {
    const { store, s } = setup()
    const controllerId = feuSur(s, 'nJourcey')
    const bilan = s().importDossierFeux(controllerId, fichier(DOSSIER_VE006))

    expect(bilan.applique).toBe(true)
    expect(bilan.dossierId).toBe('VE006')
    expect(bilan.groupes).toBeGreaterThan(0)
    const controller = s().project?.network.controllers[controllerId]
    expect(controller?.source).toBe('dossier VE006')
    expect(controller?.plans?.length).toBe(1)
    expect(controller?.interGreen).toBeTruthy()
    // Le contrôleur en place est remplacé, pas doublé : le carrefour garde son identifiant et ses nœuds.
    expect(Object.keys(s().project?.network.controllers ?? {})).toEqual([controllerId])
    expect(controller?.nodeIds).toEqual(['nJourcey'])
    expect(s().project?.changes.at(-1)?.label).toMatch(/VE006/)

    store.getState().undo()
    expect(s().project?.network.controllers[controllerId]?.source).toBeUndefined()
    expect(s().project?.network.controls.nJourcey?.type).toBe('signals')
  })

  it('signale les groupes du dossier qu’aucun mouvement du carrefour ne porte', () => {
    const { s } = setup()
    // Le dossier décrit les trois branches du carrefour réel ; ce nœud-ci n'en porte que deux.
    const bilan = s().importDossierFeux(feuSur(s, 'nJourcey'), fichier(DOSSIER_VE006))
    const reserve = bilan.avertissements.find((a) => /ne commandent rien/.test(a))
    expect(reserve).toBeDefined()
    expect(reserve).toMatch(/V1|P2/)
    expect(reserve).toMatch(/dossier est bien celui de ce carrefour/)
  })

  it('ne touche à rien et explique pourquoi si le fichier est illisible', () => {
    const { s } = setup()
    const controllerId = feuSur(s, 'nJourcey')
    const avant = s().project?.network
    const bilan = s().importDossierFeux(controllerId, 'ceci n’est pas du JSON')
    expect(bilan.applique).toBe(false)
    expect(bilan.avertissements[0]).toMatch(/JSON valide/)
    expect(s().project?.network).toBe(avant)
  })

  it('refuse un fichier qui rassemble plusieurs dossiers, plutôt que d’en choisir un', () => {
    const { s } = setup()
    const controllerId = feuSur(s, 'nJourcey')
    const autre = { ...DOSSIER_VE006, id: 'VE007', nom: 'Guillonnière / Avenue de la Libération' }
    const bilan = s().importDossierFeux(controllerId, JSON.stringify({ carrefours: [DOSSIER_VE006, autre] }))
    expect(bilan.applique).toBe(false)
    expect(bilan.avertissements[0]).toMatch(/VE006, VE007/)
    expect(s().project?.network.controllers[controllerId]?.source).toBeUndefined()
  })

  it('garde le bilan lisible après coup, et l’oublie au chargement d’un autre projet', () => {
    const { store, s } = setup()
    const controllerId = feuSur(s, 'nJourcey')
    const bilan = s().importDossierFeux(controllerId, fichier(DOSSIER_VE006))
    expect(s().dossierRapport).toEqual(bilan)
    expect(s().dossierRapport?.controllerId).toBe(controllerId)
    store.getState().loadProject(makeProject(reseauVe006()))
    expect(s().dossierRapport).toBeNull()
  })
})

describe('détachement d’un dossier (resetControllerPlan)', () => {
  it('rend le carrefour au plan par défaut, données de dossier comprises', () => {
    const { s } = setup()
    const controllerId = feuSur(s, 'nJourcey')
    s().importDossierFeux(controllerId, fichier(DOSSIER_VE006))
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
