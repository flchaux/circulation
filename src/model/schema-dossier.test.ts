/**
 * Dossiers de carrefour (docs/ARCHITECTURE.md §14) : ce que `validateProject` accepte, ce qu'il répare en
 * silence, et ce que le store en fait (import d'un fichier, plan de feux imposé).
 *
 * Deux exigences guident ces tests : un projet enregistré avant les dossiers doit ressortir **inchangé**,
 * et un champ mal formé ne doit jamais rendre un projet illisible — il disparaît, comme le reste du fichier.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, defaultDemand } from './defaults'
import { activePlan, controllerCycle, planPhaseTiming } from './signals'
import type { NetEdge, NetNode, Network, Project, SignalController } from './types'
import { PROJECT_FORMAT, PROJECT_VERSION } from './types'
import { validateProject } from './schema'
import type { FromWorker, ToWorker } from '@/engine/protocol'
import { createAppStore } from '@/state/store'
import type { AppState } from '@/state/storeTypes'

/* ------------------------------------------------------------------ */
/*  Réseau et projet de test                                           */
/* ------------------------------------------------------------------ */

function node(id: string, x: number, y: number, boundary = false): NetNode {
  return { id, x, y, boundary }
}

function edge(id: string, from: NetNode, to: NetNode, name: string): NetEdge {
  return {
    id,
    from: from.id,
    to: to.id,
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
  }
}

/** Croisement de deux rues nommées : l'avenue d'est en ouest, la rue du nord au sud. */
function croisement(): Network {
  const c = node('c', 0, 0)
  const branches: [NetNode, string][] = [
    [node('w', -200, 0, true), 'Avenue de la Libération'],
    [node('e', 200, 0, true), 'Avenue de la Libération'],
    [node('n', 0, 200, true), 'Rue de la Croix de Borne'],
    [node('s', 0, -200, true), 'Rue de la Croix de Borne'],
  ]
  const nodes: Record<string, NetNode> = { c }
  const edges: Record<string, NetEdge> = {}
  for (const [branche, nom] of branches) {
    nodes[branche.id] = branche
    edges[`${branche.id}c`] = { ...edge(`${branche.id}c`, branche, c, nom), reverseOf: `c${branche.id}` }
    edges[`c${branche.id}`] = { ...edge(`c${branche.id}`, c, branche, nom), reverseOf: `${branche.id}c` }
  }
  return { nodes, edges, controls: {}, controllers: {} }
}

/** Contrôleur « historique » : aucun champ de dossier de carrefour. */
function controleurSimple(): SignalController {
  return {
    id: 'c1',
    name: 'Carrefour central',
    nodeIds: ['c'],
    mode: 'fixed',
    offset: 0,
    amber: 3,
    allRed: 2,
    phases: [
      { id: 'p1', name: 'Axe principal', green: 30, movements: { 'wc>ce': 'protected' }, minGreen: 7, maxGreen: 60, gap: 3 },
      { id: 'p2', name: 'Axe secondaire', green: 20, movements: { 'nc>cs': 'protected' }, minGreen: 7, maxGreen: 60, gap: 3 },
    ],
    actuated: { skipEmpty: true },
  }
}

/** Contrôleur issu d'un dossier : groupes, inter-verts, deux plans et un calendrier. */
function controleurDossier(): SignalController {
  return {
    ...controleurSimple(),
    phases: [
      { id: 'p1', name: 'Phase A', green: 30, movements: { 'wc>ce': 'protected' }, groups: ['V1'], minGreen: 15, maxGreen: 40, gap: 3 },
      { id: 'p2', name: 'Phase B', green: 20, movements: { 'nc>cs': 'protected' }, groups: ['V3', 'P2'], minGreen: 10, maxGreen: 25, gap: 3 },
    ],
    groups: [
      { id: 'V1', type: 'vehicule', label: 'Avenue de la Libération', movements: ['wc>ce'] },
      { id: 'V3', type: 'vehicule', label: 'Rue de la Croix de Borne', movements: ['nc>cs'] },
      { id: 'P2', type: 'pieton', label: 'Traversée de l’avenue', movements: ['wc>ce'], recall: true },
    ],
    interGreen: { V1: { V3: 6, P2: 5 }, V3: { V1: 6 }, P2: { V1: 5 } },
    amberByGroup: { V1: 3, V3: 3 },
    plans: [
      { id: 'PF1', name: 'PF1', period: 'Heures de pointe', cycle: 74, offset: 0, phases: { p1: { green: 40 }, p2: { green: 25 } } },
      { id: 'PF2', name: 'PF2', period: 'Heures creuses', cycle: 60, offset: 0, phases: { p1: { green: 30 }, p2: { green: 20 } } },
    ],
    schedule: [
      { planId: 'PF1', fromMin: 360, toMin: 540, days: [1, 2, 3, 4, 5] },
      { planId: 'PF2', fromMin: 540, toMin: 990, days: [] },
    ],
    source: 'dossier VE005',
  }
}

function projet(controller: SignalController): Project {
  const network = croisement()
  network.controllers = { [controller.id]: controller }
  network.controls = { c: { nodeId: 'c', type: 'signals', controllerId: controller.id } }
  const at = '2026-01-01T00:00:00.000Z'
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    meta: { id: 'test', name: 'Projet de test', createdAt: at, updatedAt: at, center: { lon: 4.29, lat: 45.56 }, attribution: 'test' },
    network,
    demand: defaultDemand(network),
    settings: { ...DEFAULT_SETTINGS },
    changes: [],
  }
}

/** Passe le projet par un aller-retour JSON, comme le fait un export suivi d'un import. */
function relire(project: Project): Project {
  const result = validateProject(JSON.parse(JSON.stringify(project)))
  if (!result.ok) throw new Error(`projet refusé : ${result.errors.join(' ')}`)
  return result.project
}

/** Valide un contrôleur donné sous forme brute (champs mal formés compris) et renvoie le résultat. */
function relireControleur(raw: Record<string, unknown>): SignalController {
  const base = projet(controleurSimple())
  const brut = JSON.parse(JSON.stringify(base)) as Record<string, unknown>
  const network = brut.network as { controllers: Record<string, unknown> }
  network.controllers = { c1: { ...(network.controllers.c1 as Record<string, unknown>), ...raw } }
  const result = validateProject(brut)
  if (!result.ok) throw new Error(`projet refusé : ${result.errors.join(' ')}`)
  return result.project.network.controllers.c1
}

/* ------------------------------------------------------------------ */
/*  Rétrocompatibilité                                                 */
/* ------------------------------------------------------------------ */

describe('validateProject — projets antérieurs aux dossiers de carrefour', () => {
  it('laisse un contrôleur sans groupes ni plans exactement tel quel', () => {
    const avant = projet(controleurSimple())
    const apres = relire(avant)
    expect(apres.network.controllers.c1).toEqual(avant.network.controllers.c1)
    // Aucun champ de dossier n'est ajouté : un projet relu puis réexporté reste identique octet pour octet.
    for (const champ of ['groups', 'interGreen', 'amberByGroup', 'plans', 'schedule', 'source']) {
      expect(champ in apres.network.controllers.c1).toBe(false)
    }
    expect('groups' in apres.network.controllers.c1.phases[0]).toBe(false)
  })

  it('complète les réglages horaires absents par les valeurs par défaut', () => {
    const brut = JSON.parse(JSON.stringify(projet(controleurSimple()))) as Record<string, unknown>
    const settings = brut.settings as Record<string, unknown>
    delete settings.startTimeOfDayMin
    delete settings.dayOfWeek
    const result = validateProject(brut)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project.settings.startTimeOfDayMin).toBe(DEFAULT_SETTINGS.startTimeOfDayMin)
    expect(result.project.settings.dayOfWeek).toBe(DEFAULT_SETTINGS.dayOfWeek)
  })

  it('ramène une heure ou un jour hors bornes dans la journée et la semaine', () => {
    const brut = JSON.parse(JSON.stringify(projet(controleurSimple()))) as Record<string, unknown>
    Object.assign(brut.settings as Record<string, unknown>, { startTimeOfDayMin: -30, dayOfWeek: 9 })
    const result = validateProject(brut)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project.settings.startTimeOfDayMin).toBe(0)
    expect(result.project.settings.dayOfWeek).toBe(7)
  })
})

/* ------------------------------------------------------------------ */
/*  Conservation d'un dossier complet                                  */
/* ------------------------------------------------------------------ */

describe('validateProject — dossier de carrefour complet', () => {
  it('conserve groupes, inter-verts, plans, calendrier et origine', () => {
    const avant = projet(controleurDossier())
    const apres = relire(avant)
    expect(apres.network.controllers.c1).toEqual(avant.network.controllers.c1)
  })

  it('est idempotent : relire deux fois ne change plus rien', () => {
    const une = relire(projet(controleurDossier()))
    expect(relire(une)).toEqual(une)
  })

  it('laisse les plans piloter les durées relues', () => {
    const controller = relire(projet(controleurDossier())).network.controllers.c1
    const pointe = activePlan(controller, 7 * 60, 2)
    const creuse = activePlan(controller, 12 * 60, 2)
    expect(pointe?.id).toBe('PF1')
    expect(creuse?.id).toBe('PF2')
    expect(planPhaseTiming(controller.phases[0], pointe).green).toBe(40)
    // Cycle = verts du plan + inter-verts de la matrice (6 s dans chaque sens) : 40 + 6 + 25 + 6.
    expect(controllerCycle(controller, pointe)).toBe(77)
  })
})

/* ------------------------------------------------------------------ */
/*  Réparation silencieuse des champs mal formés                       */
/* ------------------------------------------------------------------ */

describe('validateProject — réparation des dossiers mal formés', () => {
  it('écarte des groupes ce qui n’en est pas un', () => {
    const c = relireControleur({
      groups: [
        'V1',                                                        // pas un objet
        { type: 'vehicule', movements: [] },                         // sans identifiant
        { id: 'V1', type: 'vehicule', movements: ['wc>ce', 'wc>ce'] },
        { id: 'V1', type: 'vehicule', movements: [] },               // doublon d'identifiant
        { id: 'P2', movements: ['wc>ce'], recall: 'oui' },           // type absent, rappel non booléen
        { id: 'V9', type: 'inconnu', movements: ['wc>disparu', 'sans-chevron'] },
      ],
    })
    expect(c.groups?.map((g) => g.id)).toEqual(['V1', 'P2', 'V9'])
    expect(c.groups?.[0].movements).toEqual(['wc>ce'])
    // À défaut de type lisible, l'initiale du dossier fait foi : `P2` est une traversée piétonne.
    expect(c.groups?.[1].type).toBe('pieton')
    expect(c.groups?.[1].recall).toBeUndefined()
    expect(c.groups?.[2].type).toBe('vehicule')
    // Un mouvement dont un tronçon a disparu ne désigne plus rien.
    expect(c.groups?.[2].movements).toEqual([])
  })

  it('ne garde de la matrice que des secondes positives entre groupes connus', () => {
    const c = relireControleur({
      groups: [{ id: 'V1', type: 'vehicule', movements: [] }, { id: 'V3', type: 'vehicule', movements: [] }],
      interGreen: { V1: { V3: 6, V9: 4, mauvais: -1 }, V9: { V1: 5 }, V3: 'six' },
      amberByGroup: { V1: 3, V9: 3, V3: -2 },
    })
    expect(c.interGreen).toEqual({ V1: { V3: 6 } })
    expect(c.amberByGroup).toEqual({ V1: 3 })
  })

  it('retire une matrice devenue vide plutôt que d’en laisser une coquille', () => {
    const c = relireControleur({
      groups: [{ id: 'V1', type: 'vehicule', movements: [] }],
      interGreen: { V9: { V8: 4 } },
      amberByGroup: {},
    })
    expect(c.interGreen).toBeUndefined()
    expect(c.amberByGroup).toBeUndefined()
  })

  it('répare les plans : identifiants, doublons, durées illisibles', () => {
    const c = relireControleur({
      plans: [
        'PF1',
        { name: 'Sans identifiant', cycle: -10, offset: -2, phases: { p1: { green: 40, minGreen: 15, maxGreen: 'trente' } } },
        { id: 'PF2', phases: { p1: { green: 'quarante' }, p2: { green: 20 } } },
        { id: 'PF2', phases: { p1: { green: 99 } } },
      ],
    })
    expect(c.plans?.map((p) => p.id)).toEqual(['plan1', 'PF2'])
    expect(c.plans?.[0].cycle).toBe(0)
    expect(c.plans?.[0].offset).toBe(0)
    expect(c.plans?.[0].phases.p1).toEqual({ green: 40, minGreen: 15 })
    // Sans durée de vert lisible, la phase garde la sienne : mieux vaut cela qu'un vert nul imposé.
    expect(c.plans?.[1].phases.p1).toBeUndefined()
    expect(c.plans?.[1].phases.p2.green).toBe(20)
  })

  it('nettoie les plages horaires et laisse le contrôleur lisible', () => {
    const c = relireControleur({
      plans: [{ id: 'PF1', name: 'PF1', cycle: 60, offset: 0, phases: {} }],
      schedule: [
        { planId: 'PF1', fromMin: 360, toMin: 540, days: [1, 1, 9, 5, 0] },
        { planId: 'PF1', fromMin: 1380, toMin: 1500 },
        { fromMin: 0, toMin: 60, days: [] },       // sans plan : plage sans objet
        { planId: 'PF1', toMin: 60 },              // sans borne de début
      ],
    })
    expect(c.schedule).toEqual([
      { planId: 'PF1', fromMin: 360, toMin: 540, days: [1, 5] },
      { planId: 'PF1', fromMin: 1380, toMin: 1440, days: [] },
    ])
  })

  it('écarte les champs de dossier absurdes sans rejeter le projet', () => {
    const c = relireControleur({
      groups: 'V1, V3',
      interGreen: 42,
      plans: { PF1: {} },
      schedule: 'lundi',
      source: '',
      phases: [{ id: 'p1', name: 'Phase A', green: 30, movements: {}, groups: ['V1', 'V1', 7], minGreen: 7, maxGreen: 60, gap: 3 }],
    })
    expect(c.groups).toBeUndefined()
    expect(c.interGreen).toBeUndefined()
    expect(c.plans).toBeUndefined()
    expect(c.schedule).toBeUndefined()
    expect(c.source).toBeUndefined()
    // Un identifiant de groupe inconnu est conservé : `validateController` le signale comme anomalie,
    // ce qui vaut mieux qu'une disparition muette.
    expect(c.phases[0].groups).toEqual(['V1'])
  })
})

/* ------------------------------------------------------------------ */
/*  Store : import des dossiers et plan imposé                         */
/* ------------------------------------------------------------------ */

/**
 * Dossier d'un carrefour réduit au strict nécessaire, au format documenté en §14 : un fichier, un
 * carrefour, sous les métadonnées de commune que porte la racine du fichier livré par la mairie.
 */
function dossierVE005(): Record<string, unknown> {
  return {
    commune: 'Veauche (Loire, 42340)',
    date_extraction: '2026-09-07',
    id: 'VE005',
    nom: 'VE005 Croix de Borne / Libération',
    voies: ['Avenue de la Libération', 'Rue de la Croix de Borne'],
    identification: { controleur: 'SEREL CTM 2000' },
    groupes: [
      { id: 'V1', type: 'vehicule', voie: 'Avenue de la Libération' },
      { id: 'V3', type: 'vehicule', voie: 'Rue de la Croix de Borne' },
      { id: 'P2', type: 'pieton', voie: 'Avenue de la Libération' },
    ],
    phases: [
      { nom: 'Phase A Repos', vehicules: ['V1'], pietons: [], mini_s: 15, maxi_s: 40 },
      { nom: 'Phase B', vehicules: ['V3'], pietons: ['P2'], mini_s: 10, maxi_s: 25 },
    ],
    plans_de_feux: [
      { nom: 'PF1', periode: 'Heures de pointe', cycle_s: 74, phases: [{ nom: 'Phase A Repos', mini_s: 15, maxi_s: 40 }, { nom: 'Phase B', mini_s: 10, maxi_s: 25 }] },
      { nom: 'PF2', periode: 'Heures creuses', cycle_s: 60, phases: [{ nom: 'Phase A Repos', mini_s: 12, maxi_s: 30 }, { nom: 'Phase B', mini_s: 8, maxi_s: 20 }] },
    ],
    calendrier: { lundi_vendredi: [{ plage: '06:00-09:00', plan: 'PF1' }, { plage: '09:00-16:30', plan: 'PF2' }] },
    matrice_inter_verts: { groupes: ['V1', 'V3', 'P2'], valeurs: { V1: { V3: 6, P2: 5 }, V3: { V1: 6 }, P2: { V1: 5 } }, valeur_jaune_s: { V1: 3, V3: 3 } },
  }
}

/** Ce dossier tel qu'il arrive à l'import : le texte du fichier choisi par l'exploitant. */
function fichierDossier(dossier: Record<string, unknown> = dossierVE005()): string {
  return JSON.stringify(dossier)
}

/** Store de test : client moteur factice, pas d'autosauvegarde. `controller` nul = carrefour sans feux. */
function setup(controller: SignalController | null) {
  const sent: ToWorker[] = []
  let listener: ((msg: FromWorker) => void) | null = null
  const store = createAppStore({
    persist: false,
    createClient: (onMessage) => {
      listener = onMessage
      return { send: (msg) => { sent.push(msg) }, dispose: () => {} }
    },
  })
  const base = projet(controller ?? controleurSimple())
  if (!controller) {
    base.network.controllers = {}
    base.network.controls = {}
  }
  store.getState().loadProject(base)
  return {
    store,
    sent,
    s: (): AppState => store.getState(),
    emit: (msg: FromWorker): void => listener?.(msg),
  }
}

describe('store — import du dossier d’un carrefour', () => {
  it('applique le dossier au carrefour sélectionné, journalise l’opération et reste annulable', () => {
    const { store, s } = setup(controleurSimple())
    const bilan = s().importDossierFeux('c1', fichierDossier())

    expect(bilan.applique).toBe(true)
    expect(bilan.dossierId).toBe('VE005')
    const controller = s().project?.network.controllers.c1
    expect(controller?.groups?.length).toBeGreaterThan(0)
    expect(controller?.plans?.length).toBe(2)
    expect(controller?.source).toBe('dossier VE005')
    // Le carrefour garde son contrôleur et sa régulation : le dossier remplace le plan, rien d'autre.
    expect(Object.keys(s().project?.network.controllers ?? {})).toEqual(['c1'])
    expect(s().project?.network.controls.c?.controllerId).toBe('c1')
    expect(s().project?.changes.at(-1)?.label).toMatch(/VE005/)
    expect(s().canUndo).toBe(true)

    store.getState().undo()
    expect(s().project?.network.controllers.c1.source).toBeUndefined()
    expect(s().project?.network.controllers.c1.plans).toBeUndefined()
  })

  it('ne touche à rien et explique pourquoi si le fichier est illisible', () => {
    const { s } = setup(controleurSimple())
    const avant = s().project?.network
    const bilan = s().importDossierFeux('c1', 'ceci n’est pas du JSON')
    expect(bilan.applique).toBe(false)
    expect(bilan.avertissements.length).toBeGreaterThan(0)
    expect(s().project?.network).toBe(avant)
    expect(s().canUndo).toBe(false)
  })

  it('ne fait rien quand le carrefour visé n’est plus à feux', () => {
    const { s } = setup(null)
    const bilan = s().importDossierFeux('c1', fichierDossier())
    expect(bilan.applique).toBe(false)
    expect(bilan.avertissements.join(' ')).toMatch(/plus à feux/)
    expect(Object.keys(s().project?.network.controllers ?? {})).toHaveLength(0)
  })

  it('applique le dossier en signalant les groupes que le carrefour ne porte pas', () => {
    const { s } = setup(controleurSimple())
    const dossier = dossierVE005()
    dossier.groupes = [
      { id: 'V1', type: 'vehicule', voie: 'Avenue de la Libération' },
      { id: 'V3', type: 'vehicule', voie: 'Rue de nulle part' },
    ]
    const bilan = s().importDossierFeux('c1', fichierDossier(dossier))
    expect(bilan.applique).toBe(true)
    expect(bilan.avertissements.join(' ')).toMatch(/V3.*ne commandent rien/)
  })
})

describe('store — plan de feux imposé', () => {
  it('mémorise le choix hors du projet et revient au calendrier', () => {
    const { s } = setup(controleurDossier())
    const avant = s().project

    s().setActivePlan('c1', 'PF2')
    expect(s().ui.planApercu).toEqual({ c1: 'PF2' })
    // Réglage d'affichage : ni modification du projet, ni entrée d'historique.
    expect(s().project).toBe(avant)
    expect(s().canUndo).toBe(false)

    s().setActivePlan('c1', 'inconnu')
    expect(s().ui.planApercu).toEqual({})
    s().setActivePlan('c1', 'PF1')
    s().setActivePlan('c1', null)
    expect(s().ui.planApercu).toEqual({})
  })

  it('impose le plan au moteur et rend la simulation périmée hors exécution', () => {
    const { s, sent } = setup(controleurDossier())
    s().simStart()
    sent.length = 0

    s().setActivePlan('c1', 'PF2')
    // Simulation à l'arrêt : rien n'est envoyé, mais le prochain lancement repartira avec le plan choisi.
    expect(sent).toHaveLength(0)
    expect(s().sim.stale).toBe(true)

    s().simStart()
    const init = sent.find((m) => m.type === 'init')
    expect(init?.type).toBe('init')
    if (init?.type !== 'init') return
    const controller = init.payload.network.controllers.c1
    expect(controller.plans?.[0].id).toBe('PF2')
    // Le calendrier disparaît : `activePlan` retient le plan imposé quelle que soit l'heure simulée.
    expect(controller.schedule).toBeUndefined()
    expect(activePlan(controller, 7 * 60, 2)?.id).toBe('PF2')
    // Le projet, lui, garde son calendrier intact.
    expect(s().project?.network.controllers.c1.schedule).toHaveLength(2)
  })

  it('applique le plan imposé à chaud pendant une exécution', () => {
    const { s, sent, emit } = setup(controleurDossier())
    s().simStart()
    emit({ type: 'ready', edgeIndex: [], endTime: 4200, warnings: [] })
    emit({ type: 'status', status: 'running', time: 0, endTime: 4200, stepsPerSecond: 0 })
    sent.length = 0

    s().setActivePlan('c1', 'PF2')
    const msg = sent.at(-1)
    expect(msg?.type).toBe('updateSignals')
    if (msg?.type !== 'updateSignals') return
    expect(msg.controllers.c1.plans?.[0].id).toBe('PF2')
    // Une mise à jour à chaud ne périme pas la simulation en cours.
    expect(s().sim.stale).toBe(false)
  })

  it('oublie un plan imposé disparu du projet', () => {
    const { store, s } = setup(controleurDossier())
    s().setActivePlan('c1', 'PF2')
    store.getState().deleteNode('c')
    expect(s().ui.planApercu).toEqual({})
  })
})
