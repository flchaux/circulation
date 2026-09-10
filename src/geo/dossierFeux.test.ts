/**
 * Import des dossiers de carrefour.
 *
 * Le fichier réel de la commune n'étant pas disponible ici, les fixtures sont écrites à partir du format
 * documenté (docs/ARCHITECTURE.md §14 et la documentation du fichier `veauche_feux_tricolores.json`) et
 * reprennent ses valeurs vérifiables : VE005, plan PF1, phase A Repos, maxi_s = 40 ;
 * `matrice_inter_verts.valeurs.V1.P2` = 5.
 */
import { describe, expect, it } from 'vitest'
import type { NetEdge, NetNode, Network, NodeId, SignalController } from '@/model/types'
import { DEFAULT_SIGNAL_TIMING } from '@/model/defaults'
import { phaseMovements, validateController } from '@/model/signals'
import type { DossierImportResult } from './dossierFeux'
import {
  heureEnMinutes, heuresDuTexte, importDossierFeux, joursDuLibelle, memeVoie,
  normaliserVoie, plagesDuTexte, typeDeGroupeDeclare,
} from './dossierFeux'

/* ------------------------------------------------------------------ */
/*  Réseau de test : quatre carrefours nommés comme à Veauche          */
/* ------------------------------------------------------------------ */

/** Constructeur de réseau minimal, partagé par les réseaux de test. */
function constructeurReseau() {
  const nodes: Record<NodeId, NetNode> = {}
  const edges: Record<string, NetEdge> = {}
  const noeud = (id: string, x: number, y: number, boundary = false) => { nodes[id] = { id, x, y, boundary } }
  const tronçon = (de: string, vers: string, nom: string, inverse?: string): NetEdge => ({
    id: `${de}_${vers}`,
    from: de,
    to: vers,
    reverseOf: inverse,
    name: nom,
    highway: 'secondary',
    lanes: 1,
    maxspeed: 50,
    length: Math.hypot(nodes[de].x - nodes[vers].x, nodes[de].y - nodes[vers].y),
    geometry: [[nodes[de].x, nodes[de].y], [nodes[vers].x, nodes[vers].y]],
    roundabout: false,
    closed: false,
    bannedTo: [],
    estimated: { lanes: false, maxspeed: false },
  })
  const branche = (a: string, b: string, nom: string) => {
    edges[`${a}_${b}`] = tronçon(a, b, nom, `${b}_${a}`)
    edges[`${b}_${a}`] = tronçon(b, a, nom, `${a}_${b}`)
  }
  /** Tronçon à sens unique : `b` y gagne une approche, `a` n'en gagne aucune (il ne fait que la quitter). */
  const sensUnique = (a: string, b: string, nom: string) => { edges[`${a}_${b}`] = tronçon(a, b, nom) }
  const reseau = (): Network => ({ nodes, edges, controls: {}, controllers: {} })
  return { noeud, branche, sensUnique, reseau }
}

function reseauDeTest(): Network {
  const { noeud, branche, reseau } = constructeurReseau()

  // Avenue de la Libération d'ouest en est, coupée par la Croix de Borne puis par Jourcey.
  noeud('w', -200, 0, true)
  noeud('cLib', 0, 0)
  noeud('cJou', 300, 0)
  noeud('e', 500, 0, true)
  noeud('nBorne', 0, 200, true)
  noeud('sBorne', 0, -200, true)
  noeud('nJourcey', 300, 200, true)
  branche('w', 'cLib', 'Avenue de la Libération')
  branche('cLib', 'cJou', 'Avenue de la Libération')
  branche('cJou', 'e', 'Avenue de la Libération')
  branche('nBorne', 'cLib', 'Rue de la Croix de Borne')
  branche('sBorne', 'cLib', 'Rue de la Croix de Borne')
  branche('nJourcey', 'cJou', 'Rue de Jourcey')

  // Place de l'Europe et son unique rue transversale.
  noeud('cEurope', 0, 600)
  noeud('wEurope', -200, 600, true)
  noeud('eEurope', 200, 600, true)
  noeud('nStade', 0, 800, true)
  branche('wEurope', 'cEurope', "Place de l'Europe")
  branche('eEurope', 'cEurope', "Place de l'Europe")
  branche('nStade', 'cEurope', 'Rue du Stade')

  // Marcel Pagnol / Saint-Bonnet-les-Oules : libellés abrégés dans le dossier.
  noeud('cPagnol', 0, -600)
  noeud('nPagnol', 0, -400, true)
  noeud('sPagnol', 0, -800, true)
  noeud('eBonnet', 200, -600, true)
  branche('nPagnol', 'cPagnol', 'Rue Marcel Pagnol')
  branche('sPagnol', 'cPagnol', 'Rue Marcel Pagnol')
  branche('eBonnet', 'cPagnol', 'Route de Saint-Bonnet-les-Oules')

  return reseau()
}

/**
 * Réseau écrit comme OSM l'écrit à Veauche : « Rue du Docteur Masourenok » (sans prénom), « Rue de la
 * Croix Borne » (sans « de »), apostrophe typographique. Un second carrefour porte la « Croix des Pères »,
 * la voie à ne surtout pas confondre avec la « Croix de Borne ».
 */
function reseauEcritureOsm(): Network {
  const { noeud, branche, reseau } = constructeurReseau()
  noeud('c', 0, 0)
  noeud('wGaulle', -300, 0, true)
  noeud('eGaulle', 300, 0)
  noeud('nMaso', 0, 250, true)
  noeud('sBorne', 0, -250, true)
  branche('wGaulle', 'c', 'Avenue du Général de Gaulle')
  branche('eGaulle', 'c', 'Avenue du Général de Gaulle')
  branche('nMaso', 'c', 'Rue du Docteur Masourenok')
  branche('sBorne', 'c', 'Rue de la Croix Borne')

  noeud('nPeres', 300, 250, true)
  noeud('sPeres', 300, -250, true)
  branche('nPeres', 'eGaulle', 'Rue de la Croix des Pères')
  branche('sPeres', 'eGaulle', 'Rue de la Croix des Pères')

  noeud('cEurope', 0, 900)
  noeud('wEurope', -300, 900, true)
  noeud('eEurope', 300, 900, true)
  noeud('nStade', 0, 1150, true)
  branche('wEurope', 'cEurope', 'Place de l\u2019Europe')
  branche('eEurope', 'cEurope', 'Place de l\u2019Europe')
  branche('nStade', 'cEurope', 'Rue du Stade')
  return reseau()
}

/**
 * Carrefour où la même avenue arrive par deux côtés : l'Avenue de la Libération (D1082) du nord au sud,
 * coupée par la Rue du Docteur Masourenok à l'ouest et la Rue de la Croix Borne à l'est. C'est le cas
 * courant des dossiers réels, qui distinguent alors les deux approches par un point cardinal.
 */
function reseauAvenueNordSud(): Network {
  const { noeud, branche, reseau } = constructeurReseau()
  noeud('c', 0, 0)
  noeud('nLib', 0, 250, true)
  noeud('sLib', 0, -250, true)
  noeud('wMaso', -250, 0, true)
  noeud('eBorne', 250, 0, true)
  branche('nLib', 'c', 'Avenue de la Libération')
  branche('sLib', 'c', 'Avenue de la Libération')
  branche('wMaso', 'c', 'Rue du Docteur Masourenok')
  branche('eBorne', 'c', 'Rue de la Croix Borne')
  return reseau()
}

/* ------------------------------------------------------------------ */
/*  Fixtures de dossiers                                               */
/* ------------------------------------------------------------------ */

function fichier(...carrefours: unknown[]): unknown {
  return {
    commune: 'Veauche (Loire, 42340)',
    objet: 'Dossiers de carrefour des feux tricolores',
    date_extraction: '2026-08-30',
    nombre_dossiers: carrefours.length,
    glossaire: { Vn: 'groupe véhicules', Pn: 'groupe piétons', IV: 'inter-vert', HPM: 'heure de pointe du matin' },
    carrefours,
  }
}

/** VE005 : deux plans, calendrier, matrice symétrique, et quantité de champs matériels à ignorer. */
function ve005(): Record<string, unknown> {
  return {
    id: 'VE005',
    nom: 'VE005 Croix de Borne / Avenue de la Libération',
    fichier_source: 'Dossier_Crf_Veauche_VE005-_Croix_de_Borne_-_Liberation_-_v1.pdf',
    modele_dossier: 'Saint-Étienne Métropole',
    voies: ['Avenue de la Libération', 'Rue de la Croix de Borne'],
    identification: {
      numero_carrefour: 'VE005',
      controleur: 'SEREL CTM 2000',
      numero_serie_controleur: 'SN-778812',
      mise_en_service_dernier_controleur: '2016-05-12',
      visu: 'AXIMUM',
      mode_fonctionnement: 'cyclique',
      nombre_phases_trafic: 2,
    },
    inventaire_materiel: {
      marque_controleur: 'BOUYGUES ENERGIES ET SERVICES',
      enveloppe_armoire: 'ARMEO',
      armoire: { cartes_puissance: 4, carte_cpu: 1, clavier_afficheur: 'oui' },
      visualisation: { nombre_boucles: 6, lanternes_200: 12, caissons_pietons: 4 },
    },
    raccordement: { cpu: 'CPU-1', cartes_puissance_MPM: { MPM1: ['V1', 'V3'] }, entrees: { '50-01': 'BPP1' } },
    malvoyants: { marque: 'OKEENEA', version_firmware_SV: '3.2.1', traversees: [{ poteau: 'P12' }] },
    alimentation_electrique: { type_branchement: 'monophasé', numero_pdl: '14235698741250', puissance_souscrite: '6 kVA' },
    controles_reglementaires: { controle_electrique: [{ date: '2019-10-18', organisme: 'CONSUEL' }] },
    historique_modifications: [{ date: '2021-03-02', indice: 'v1', objet: 'Mise à jour du plan de feux' }],
    groupes: [
      { id: 'V1', type: 'vehicule', voie: 'Avenue de la Libération', detecteurs: ['B11', 'B12'], signaux: ['1', '2'] },
      { id: 'P2', type: 'pieton', voie: 'Traversée Avenue de la Libération', boutons_poussoirs: ['BPP1'] },
      { id: 'V3', type: 'vehicule', voie: 'Rue de la Croix de Borne', detecteurs: ['RAD1'] },
      { id: 'P4', type: 'pieton', voie: 'Traversée Rue de la Croix de Borne', boutons_poussoirs: ['BPP2'] },
    ],
    phases: [
      { nom: 'Phase A Repos', vehicules: ['V1'], pietons: ['P4'], mini_s: 15, maxi_s: 40, pietons_en_rappel: true },
      { nom: 'Phase B', vehicules: ['V3'], pietons: ['P2'], mini_s: 10, maxi_s: 25 },
    ],
    plans_de_feux: [
      {
        nom: 'PF1',
        periode: 'Heures de pointe',
        cycle_s: 74,
        point_repos_s: 0,
        phases: [
          { nom: 'Phase A Repos', mini_s: 15, maxi_s: 40 },
          { nom: 'Phase B', mini_s: 10, maxi_s: 25 },
        ],
      },
      {
        nom: 'PF2',
        periode: 'Heures creuses',
        cycle_s: 60,
        phases: [
          { nom: 'Phase A Repos', mini_s: 12, maxi_s: 30 },
          { nom: 'Phase B', mini_s: 8, maxi_s: 20 },
        ],
      },
    ],
    calendrier: {
      lundi_vendredi: [
        { plage: '06:00-09:00', plan: 'PF1' },
        { plage: '09h00 - 16h30', plan: 'PF2' },
      ],
      samedi_dimanche: [{ plage: '07:00-22:00', plan: 'PF2' }],
    },
    matrice_inter_verts: {
      convention: 'ligne = groupe qui perd le vert, colonne = groupe qui prend le vert, valeur en secondes',
      groupes: ['V1', 'P2', 'V3', 'P4'],
      valeurs: {
        V1: { P2: 5, V3: 6 },
        P2: { V1: 5 },
        V3: { V1: 6, P4: 5 },
        P4: { V3: 5 },
      },
      valeur_jaune_s: { V1: 3, V3: 3 },
      valeur_securite_s: { V1: 2, V3: 2 },
    },
    matrice_rouges_degagement: { groupes: ['V1', 'V3'], valeurs: { V1: { V3: 3 }, V3: { V1: 3 } } },
    notes_extraction: ["Le diagramme linéaire du cycle n'est pas repris."],
    variables_diaser: 'SANS OBJET',
    programmation: [],
  }
}

/** VE006 : un seul plan implicite (aucun `plans_de_feux`) et un calendrier nul. */
function ve006(): Record<string, unknown> {
  return {
    id: 'VE006',
    nom: 'VE006 Jourcey / Avenue de la Libération',
    voies: ['Avenue de la Libération', 'Rue de Jourcey'],
    groupes: [
      { id: 'V1', type: 'vehicule', voie: 'Avenue de la Libération' },
      { id: 'V2', type: 'vehicule', voie: 'Rue de Jourcey' },
      { id: 'P3', type: 'pieton', voie: 'Traversée Rue de Jourcey' },
    ],
    phases: [
      { nom: 'Phase A', vehicules: ['V1'], pietons: ['P3'], mini_s: 20, maxi_s: 45 },
      { nom: 'Phase B', vehicules: ['V2'], pietons: [], mini_s: 9, maxi_s: 22 },
    ],
    calendrier: null,
    matrice_inter_verts: {
      groupes: ['V1', 'V2', 'P3'],
      valeurs: { V1: { V2: 6, P3: 5 }, V2: { V1: 6 }, P3: { V1: 5 } },
      valeur_jaune_s: { V1: 3, V2: 3 },
    },
  }
}

/** VE004 : abréviations (« Rte de St Bonnet »), phase escamotable sur appel de boucle. */
function ve004(): Record<string, unknown> {
  return {
    id: 'VE004',
    nom: 'VE004 Rue Marcel Pagnol / Rte de St Bonnet les Oules',
    voies: ['Rue Marcel Pagnol', 'Rte de St Bonnet les Oules'],
    groupes: [
      { id: 'V1', type: 'vehicule', voie: 'R. Marcel Pagnol' },
      { id: 'V2', type: 'vehicule', voie: 'Rte de St Bonnet les Oules' },
    ],
    phases: [
      { nom: 'Phase A Repos', vehicules: ['V1'], mini_s: 12, maxi_s: 30 },
      {
        nom: 'Phase B escamotable',
        vehicules: ['V2'],
        mini_s: 7,
        maxi_s: 20,
        appel: ['B21'],
        prolongation: 'B21, intervalle véhicule 2,5 s',
      },
    ],
  }
}

const reseau = reseauDeTest()

/**
 * Applique un dossier au carrefour désigné, comme le fait l'exploitant : il sélectionne le feu sur la
 * carte, puis choisit le fichier de ce carrefour-là. Le réseau de test n'ayant pas de feux, on en pose
 * un sur le nœud visé — c'est l'état d'un carrefour que l'on vient de passer en « feux tricolores ».
 */
function appliquer(dossier: unknown, nodeId: NodeId = 'cLib', network: Network = reseau): DossierImportResult {
  const controleur: SignalController = {
    id: 'cTest', name: 'Carrefour à feux', nodeIds: [nodeId], mode: 'fixed', offset: 0,
    amber: DEFAULT_SIGNAL_TIMING.amber, allRed: DEFAULT_SIGNAL_TIMING.allRed, phases: [],
    actuated: { skipEmpty: true },
  }
  const avecFeux: Network = {
    ...network,
    controls: { ...network.controls, [nodeId]: { nodeId, type: 'signals', controllerId: 'cTest' } },
    controllers: { ...network.controllers, cTest: controleur },
  }
  return importDossierFeux(dossier, { network: avecFeux, controllerId: 'cTest' })
}

/* ------------------------------------------------------------------ */
/*  Normalisation des libellés                                         */
/* ------------------------------------------------------------------ */

describe('normalisation des libellés de voies', () => {
  it('ramène les abréviations et les accents à une forme commune', () => {
    expect(normaliserVoie('Av. de la Libération')?.noyau).toBe('liberation')
    expect(normaliserVoie('AVENUE DE LA LIBERATION')?.noyau).toBe('liberation')
    expect(normaliserVoie('Rte de St Bonnet les Oules')?.noyau).toBe('saint bonnet les oules')
    expect(normaliserVoie("Place de l'Europe")?.noyau).toBe('europe')
    expect(normaliserVoie('Traversée Rue de la Croix de Borne')?.noyau).toBe('croix de borne')
    expect(normaliserVoie('RD 1082')?.noyau).toBe('d1082')
  })

  it('reconnaît deux écritures de la même voie sans confondre deux voies différentes', () => {
    const a = normaliserVoie('Av. Gal de Gaulle')
    const b = normaliserVoie('Avenue du Général de Gaulle')
    const c = normaliserVoie('Avenue de la Libération')
    expect(a && b && memeVoie(a, b)).toBe(true)
    expect(a && c && memeVoie(a, c)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/*  Fixture complète à deux carrefours                                 */
/* ------------------------------------------------------------------ */

describe('import de deux dossiers, chacun sur son carrefour', () => {
  const res5 = appliquer(ve005(), 'cLib')
  const res6 = appliquer(ve006(), 'cJou')
  const c5 = res5.controller!
  const c6 = res6.controller!

  it('reprend chaque dossier sur le carrefour que l’exploitant a désigné', () => {
    expect(c5.nodeIds).toEqual(['cLib'])
    expect(c6.nodeIds).toEqual(['cJou'])
    // Le contrôleur en place est remplacé, pas doublé : même identifiant, mêmes nœuds.
    expect(c5.id).toBe('cTest')
    expect(res5.groupesNonRattaches).toEqual([])
    expect(res6.groupesNonRattaches).toEqual([])
  })

  it('reprend les groupes, leur type et les mouvements de chaque approche', () => {
    expect(c5.source).toBe('dossier VE005')
    expect(c5.groups?.map((g) => `${g.id}:${g.type}`)).toEqual(['V1:vehicule', 'P2:pieton', 'V3:vehicule', 'P4:pieton'])
    const v1 = c5.groups!.find((g) => g.id === 'V1')!
    // V1 commande les deux approches de l'Avenue de la Libération, soit trois mouvements chacune.
    expect(v1.movements).toHaveLength(6)
    expect(v1.movements).toContain('w_cLib>cLib_cJou')
    expect(v1.label).toBe('Avenue de la Libération')
    expect(res5.groupesRattaches).toBe(4)
  })

  it('donne au groupe piéton les mouvements qui franchissent sa traversée, et le signale', () => {
    const p2 = c5.groups!.find((g) => g.id === 'P2')!
    // P2 traverse l'Avenue de la Libération : tout mouvement qui y entre ou en sort la franchit.
    expect(p2.movements).toContain('w_cLib>cLib_cJou')
    expect(p2.movements).toContain('nBorne_cLib>cLib_w')
    expect(p2.movements).not.toContain('nBorne_cLib>cLib_sBorne')
    expect(res5.avertissements.some((a) => /traversée/i.test(a) && /géométrie/i.test(a))).toBe(true)
    // Ces mouvements ne sont pas « interdits » par la traversée (§14.5) : l'avertissement ne doit pas
    // laisser croire à l'exploitant qu'un rattachement de trop ferme une branche du carrefour.
    expect(res5.avertissements.some((a) => /mouvements interdits/i.test(a))).toBe(false)
  })

  it('reporte le rappel piéton déclaré par la phase sur le groupe', () => {
    expect(c5.groups!.find((g) => g.id === 'P4')!.recall).toBe(true)
    expect(c5.groups!.find((g) => g.id === 'P2')!.recall).toBeUndefined()
  })

  it('laisse au vert les mouvements que le vert piéton de la phase traverse, en cession (§14.5)', () => {
    const phaseA = c5.phases[0]
    expect(phaseA.name).toBe('Phase A Repos')
    expect(phaseA.groups).toEqual(['V1', 'P4'])
    // P4 traverse la Croix de Borne, mais V1 est vert : les tourne-à-droite et tourne-à-gauche qui la
    // franchissent gardent le vert et cèdent aux piétons. Les retirer de la phase mettrait ces
    // mouvements au rouge à tous les cycles et rendrait `phase.movements` — que lit la carte —
    // différent de ce que simule le moteur.
    expect(Object.keys(phaseA.movements).sort()).toEqual([
      'cJou_cLib>cLib_nBorne', 'cJou_cLib>cLib_sBorne', 'cJou_cLib>cLib_w',
      'w_cLib>cLib_cJou', 'w_cLib>cLib_nBorne', 'w_cLib>cLib_sBorne',
    ])
    // Le déclassement en « permis » n'est pas écrit dans la phase : il dépend du cycle (une traversée sur
    // bouton poussoir laisse le vert protégé quand personne n'appuie), c'est le moteur qui l'applique.
    expect(phaseA.movements['w_cLib>cLib_sBorne']).toBe('protected')
    const verts = phaseMovements(c5, phaseA)
    expect(verts['w_cLib>cLib_cJou']).toBe('protected')
    expect(verts['w_cLib>cLib_sBorne']).toBe('permitted')
  })

  it('reprend les mini et maxi comme vert minimal et maximal', () => {
    expect(c5.phases.map((p) => [p.minGreen, p.maxGreen])).toEqual([[15, 40], [10, 25]])
    // Sans plan de feux, le vert par défaut est le mini du dossier.
    expect(c6.plans).toBeUndefined()
    expect(c6.phases.map((p) => p.green)).toEqual([20, 9])
  })

  it('reprend les plans de feux et leur cycle', () => {
    expect(c5.plans?.map((p) => [p.id, p.name, p.cycle])).toEqual([['pf1', 'PF1', 74], ['pf2', 'PF2', 60]])
    expect(c5.plans![0].period).toBe('Heures de pointe')
    // Valeur vérifiable de la documentation : PF1, phase A Repos, maxi_s = 40.
    expect(c5.plans![0].phases.p1.maxGreen).toBe(40)
    // Le cycle annoncé est réparti entre les phases : 38 + 24 de vert + 12 d'inter-verts = 74 s.
    expect(c5.plans![0].phases.p1.green).toBe(38)
    expect(c5.plans![0].phases.p2.green).toBe(24)
  })

  it('reprend la matrice d’inter-verts et les jaunes par groupe', () => {
    // Valeur vérifiable de la documentation : matrice_inter_verts.valeurs.V1.P2 = 5.
    expect(c5.interGreen?.V1?.P2).toBe(5)
    expect(c5.interGreen?.V3?.P4).toBe(5)
    expect(c5.interGreen?.V1?.P4).toBeUndefined()
    expect(c5.amberByGroup).toEqual({ V1: 3, V3: 3 })
    expect(c5.amber).toBe(3)
  })

  it('produit un contrôleur cohérent pour la validation du modèle', () => {
    // Seul reproche possible ici : les tourne-à-droite et tourne-à-gauche sont verts en même temps que la
    // traversée qu'ils franchissent, donc en cession (§14.5) — leur capacité simulée est optimiste, faute
    // de demande piétonne au dossier. Ils ne sont plus fermés : ce serait un rouge permanent, donc une
    // approche bloquée. Aucun conflit protégé, aucun mouvement orphelin, aucune durée aberrante.
    const anomalies5 = validateController(reseau, c5)
    expect(anomalies5).toHaveLength(1)
    expect(anomalies5[0]).toMatch(/capacité simulée est optimiste/)
    const anomalies6 = validateController(reseau, c6)
    expect(anomalies6.every((a) => /capacité simulée est optimiste/.test(a))).toBe(true)
  })

  it('reste en mode fixe sans mention d’escamotage', () => {
    expect(c5.mode).toBe('fixed')
    expect(c6.mode).toBe('fixed')
  })

  it('n’importe aucune donnée de matériel, de câblage ni d’électricité', () => {
    // Ce qui est examiné est ce qui entre dans le RÉSEAU : les contrôleurs reconstruits.
    const texte = JSON.stringify([c5, c6])
    for (const interdit of [
      'BOUYGUES', 'ARMEO', 'OKEENEA', 'CONSUEL', 'SEREL', 'AXIMUM', 'SN-778812', '14235698741250',
      'MPM1', 'BPP1', 'RAD1', 'B11', 'firmware', 'cartes_puissance', 'lanternes', 'boucles',
      'monophasé', 'kVA', 'CPU-1', '50-01', 'Saint-Étienne Métropole', '2016-05-12',
    ]) {
      expect(texte).not.toContain(interdit)
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Plages horaires                                                    */
/* ------------------------------------------------------------------ */

describe('conversion des plages horaires', () => {
  it('lit les heures sous toutes leurs écritures', () => {
    expect(heuresDuTexte('06:00-09:00')).toEqual([360, 540])
    expect(heuresDuTexte('09h00 - 16h30')).toEqual([540, 990])
    expect(heuresDuTexte('7h à 9h')).toEqual([420, 540])
    expect(heureEnMinutes('22h15')).toBe(1335)
    expect(heureEnMinutes(7)).toBe(420)
    expect(heureEnMinutes('PF1')).toBeNull()
  })

  it('traduit les types de jour en numéros de 1 à 7', () => {
    expect(joursDuLibelle('lundi_vendredi')).toEqual([1, 2, 3, 4, 5])
    expect(joursDuLibelle('samedi et dimanche')).toEqual([6, 7])
    expect(joursDuLibelle('dimanche et jours fériés')).toEqual([7])
    expect(joursDuLibelle('jours ouvrables')).toEqual([1, 2, 3, 4, 5])
    expect(joursDuLibelle('tous les jours')).toEqual([])
    expect(joursDuLibelle('mercredi')).toEqual([3])
    expect(joursDuLibelle('pendant les vacances')).toBeNull()
  })

  it('convertit le calendrier en plages de minutes depuis minuit', () => {
    const res = appliquer(ve005())
    const c = res.controller!
    expect(c.schedule).toEqual([
      { planId: 'pf1', fromMin: 360, toMin: 540, days: [1, 2, 3, 4, 5] },
      { planId: 'pf2', fromMin: 540, toMin: 990, days: [1, 2, 3, 4, 5] },
      { planId: 'pf2', fromMin: 420, toMin: 1320, days: [6, 7] },
    ])
  })

  it('accepte les autres écritures de calendrier rencontrées dans les dossiers', () => {
    const dossier = ve005()
    dossier.calendrier = [
      { jours: 'lundi au vendredi', heure_debut: '06:30', heure_fin: '20:00', plan_de_feux: 'PF1' },
      { jours: 'dimanche', plage_horaire: '10h-18h', plan: 'PF2' },
    ]
    const res = appliquer(dossier)
    const c = res.controller!
    expect(c.schedule).toEqual([
      { planId: 'pf1', fromMin: 390, toMin: 1200, days: [1, 2, 3, 4, 5] },
      { planId: 'pf2', fromMin: 600, toMin: 1080, days: [7] },
    ])
  })

  it('donne un calendrier vide quand le dossier n’en porte pas', () => {
    const res = appliquer(ve006(), 'cJou')
    const c = res.controller!
    expect(c.schedule).toBeUndefined()
  })

  it('signale un plan inconnu du calendrier au lieu de l’inventer', () => {
    const dossier = ve005()
    dossier.calendrier = { lundi_vendredi: [{ plage: '06:00-09:00', plan: 'PF7' }] }
    const res = appliquer(dossier)
    expect(res.avertissements.some((a) => /PF7/.test(a))).toBe(true)
    expect(res.controller!.schedule).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/*  Matrices                                                           */
/* ------------------------------------------------------------------ */

describe('matrice d’inter-verts', () => {
  it('signale une asymétrie sans la corriger', () => {
    const dossier = ve005()
    dossier.matrice_inter_verts = {
      groupes: ['V1', 'P2', 'V3', 'P4'],
      valeurs: { V1: { P2: 5, V3: 6 }, P2: {}, V3: { V1: 6, P4: 5 }, P4: { V3: 5 } },
      valeur_jaune_s: { V1: 3, V3: 3 },
    }
    const res = appliquer(dossier)
    const c = res.controller!
    expect(res.avertissements.some((a) => /asym/i.test(a) && a.includes('V1 → P2'))).toBe(true)
    // La valeur reste telle quelle : l'importeur ne rétablit pas la symétrie à la place de l'exploitant.
    expect(c.interGreen?.V1?.P2).toBe(5)
    expect(c.interGreen?.P2).toBeUndefined()
  })

  it('signale un groupe de la matrice absent de la liste des groupes', () => {
    const dossier = ve005()
    dossier.matrice_inter_verts = {
      groupes: ['V1', 'V9'],
      valeurs: { V1: { V9: 4 }, V9: { V1: 4 } },
      valeur_jaune_s: { V1: 3 },
    }
    const res = appliquer(dossier)
    expect(res.avertissements.some((a) => /V9/.test(a))).toBe(true)
  })

  it('signale une phase qui réunit deux groupes déclarés incompatibles', () => {
    const dossier = ve005()
    const phases = dossier.phases as Record<string, unknown>[]
    phases[0].pietons = ['P2'] // P2 traverse la Libération, que V1 emprunte
    const res = appliquer(dossier)
    expect(res.avertissements.some((a) => /incompatibles/.test(a) && /V1/.test(a))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  Modes de fonctionnement                                            */
/* ------------------------------------------------------------------ */

describe('mode du contrôleur', () => {
  it('passe en adaptatif quand une phase est escamotable', () => {
    const res = appliquer(ve004(), 'cPagnol')
    const c = res.controller!
    expect(c.mode).toBe('actuated')
    expect(c.actuated.skipEmpty).toBe(true)
    // L'intervalle véhicule annoncé par la prolongation devient le temps de prolongation de la phase.
    expect(c.phases[1].gap).toBe(2.5)
  })

  it('passe en adaptatif sur mention d’escamotage dans l’identification', () => {
    const dossier = ve006()
    dossier.identification = { mode_fonctionnement: { cyclique: false, escamotage: true, onde_verte: false } }
    const res = appliquer(dossier, 'cJou')
    expect(res.controller!.mode).toBe('actuated')
  })
})

/* ------------------------------------------------------------------ */
/*  Un fichier par carrefour                                           */
/* ------------------------------------------------------------------ */

describe('un fichier par carrefour', () => {
  /** Le fichier livré par la commune : le dossier à la racine, sous les métadonnées de la commune. */
  const seul = (dossier: Record<string, unknown>): unknown => ({
    commune: 'Veauche (Loire, 42340)',
    objet: 'Dossiers de carrefour des feux tricolores',
    date_extraction: '2026-09-07',
    glossaire: { Vn: 'groupe de feux véhicules n', Pn: 'groupe de feux piétons n' },
    ...dossier,
  })

  it('applique au carrefour désigné le dossier posé seul à la racine du fichier', () => {
    const res = appliquer(seul(ve005()))
    expect(res.dossierId).toBe('VE005')
    expect(res.controller?.id).toBe('cTest')
    expect(res.controller?.nodeIds).toEqual(['cLib'])
    expect(res.controller?.source).toBe('dossier VE005')
    expect(res.groupesRattaches).toBeGreaterThan(0)
    expect(res.groupesNonRattaches).toEqual([])
    expect(res.avertissements.some((a) => /Traversées piétonnes/.test(a))).toBe(true)
  })

  it('accepte le texte du fichier aussi bien que la valeur déjà analysée', () => {
    const res = appliquer(JSON.stringify(seul(ve005())))
    expect(res.controller?.source).toBe('dossier VE005')
  })

  it('refuse un fichier qui rassemble plusieurs dossiers, en les énumérant', () => {
    const res = appliquer({ carrefours: [ve005(), ve006()] })
    expect(res.controller).toBeNull()
    expect(res.avertissements[0]).toMatch(/contient 2 dossiers \(VE005, VE006\)/)
    expect(res.avertissements[0]).toMatch(/un seul, celui du carrefour choisi/)
  })

  it('lit encore un fichier de l’ancien format qui ne contient qu’un dossier', () => {
    expect(appliquer({ carrefours: [ve005()] }).controller?.source).toBe('dossier VE005')
    expect(appliquer([ve005()]).controller?.source).toBe('dossier VE005')
  })

  it('ne touche pas au carrefour dont le contrôleur a disparu du réseau', () => {
    const res = importDossierFeux(seul(ve005()), { network: reseau, controllerId: 'cDisparu' })
    expect(res.controller).toBeNull()
    expect(res.dossierId).toBe('VE005')
    expect(res.avertissements.some((a) => /n’est plus à feux/.test(a))).toBe(true)
  })

  it('signale les groupes du dossier qu’aucun mouvement du carrefour ne porte', () => {
    // Le dossier de la Croix de Borne appliqué au carrefour de Jourcey : ses groupes ne trouvent
    // qu'une partie des approches. L'exploitant doit voir qu'il s'est trompé de fichier.
    const res = appliquer(seul(ve005()), 'cJou')
    expect(res.groupesNonRattaches.length).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ */
/*  Deux groupes sur la même rue, distingués par le côté               */
/* ------------------------------------------------------------------ */

describe('groupes distingués par un point cardinal', () => {
  /** Dossier VE005 de Veauche : quatre approches, dont deux sur la même avenue (nord et sud). */
  function dossierQuatreBranches(): Record<string, unknown> {
    return {
      id: 'VE005',
      nom: 'Masourenok / Libération / Croix Borne',
      voies: ['Rue du Docteur Masourenok', 'Avenue de la Libération (D1082)', 'Rue de la Croix Borne'],
      groupes: [
        { id: 'V1', type: 'vehicule', voie: "Rue du Docteur Masourenok / branche ouest / véhicules venant de l'ouest" },
        { id: 'P2', type: 'pieton', voie: 'Traversée de la Rue du Docteur Masourenok' },
        { id: 'V3', type: 'vehicule', voie: 'Avenue de la Libération / D1082 / véhicules venant du nord' },
        { id: 'P4', type: 'pieton', voie: "Traversée de l'Avenue de la Libération / côté nord" },
        { id: 'V5', type: 'vehicule', voie: "Rue de la Croix Borne / branche est / véhicules venant de l'est" },
        { id: 'P6', type: 'pieton', voie: 'Traversée de la Rue de la Croix Borne' },
        { id: 'V7', type: 'vehicule', voie: 'Avenue de la Libération / D1082 / véhicules venant du sud' },
        { id: 'P8', type: 'pieton', voie: "Traversée de l'Avenue de la Libération / côté sud" },
      ],
      phases: [
        { nom: 'Phase A Repos', vehicules: ['V3', 'V7'], pietons: ['P2', 'P6'], mini_s: 15, maxi_s: 40 },
        { nom: 'Phase B', vehicules: ['V1', 'V5'], pietons: ['P4', 'P8'], mini_s: 10, maxi_s: 25 },
      ],
    }
  }

  const res = appliquer(dossierQuatreBranches(), 'c', reseauAvenueNordSud())
  const groupe = (id: string) => res.controller!.groups!.find((g) => g.id === id)!

  it('donne à chaque groupe les seuls mouvements de son côté de l’avenue', () => {
    const nord = groupe('V3').movements
    const sud = groupe('V7').movements
    expect(nord.length).toBe(3)
    expect(sud.length).toBe(3)
    // Les mouvements du nord partent tous du tronçon nord, ceux du sud du tronçon sud, sans recouvrement.
    expect(nord.every((k) => k.startsWith('nLib_c>'))).toBe(true)
    expect(sud.every((k) => k.startsWith('sLib_c>'))).toBe(true)
    expect(nord.filter((k) => sud.includes(k))).toEqual([])
  })

  it('annonce la répartition comme une déduction à vérifier', () => {
    const message = res.avertissements.find((a) => /V3 \(nord\), V7 \(sud\)/.test(a))!
    expect(message).toMatch(/répartis d’après le côté|répartis d'après le côté/)
    expect(message).toMatch(/à vérifier sur le plan/)
    // L'ancien message, qui annonçait des mouvements identiques, n'a plus lieu d'être.
    expect(res.avertissements.some((a) => /mouvements sont identiques/.test(a))).toBe(false)
  })

  it('répartit aussi les deux traversées de l’avenue, sans leur retirer la traversée de part en part', () => {
    const nord = groupe('P4').movements
    const sud = groupe('P8').movements
    // Un mouvement qui entre par le nord franchit la traversée nord ; celui qui traverse le carrefour
    // du nord au sud franchit les deux.
    expect(nord).toContain('nLib_c>c_eBorne')
    expect(sud).not.toContain('nLib_c>c_eBorne')
    expect(nord).toContain('nLib_c>c_sLib')
    expect(sud).toContain('nLib_c>c_sLib')
    expect(nord.length).toBeLessThan(groupe('P2').movements.length + nord.length)
  })

  it('annonce l’approche qui restera au rouge quand le dossier ignore une branche', () => {
    // Le dossier ne décrit que l'avenue : les deux rues transversales ne sont ouvertes par aucune phase.
    // C'est le symptôme d'un dossier chargé sur le mauvais carrefour, et la cause d'un bouchon qui ne
    // se vide jamais — il doit être nommé, rue par rue, et pas seulement compté.
    const res = appliquer({
      id: 'VEX',
      nom: 'Avenue seule',
      voies: ['Avenue de la Libération'],
      groupes: [
        { id: 'V3', type: 'vehicule', voie: 'Avenue de la Libération / véhicules venant du nord' },
        { id: 'V7', type: 'vehicule', voie: 'Avenue de la Libération / véhicules venant du sud' },
      ],
      phases: [{ nom: 'Phase A', vehicules: ['V3', 'V7'], mini_s: 20, maxi_s: 40 }],
    }, 'c', reseauAvenueNordSud())
    const message = res.avertissements.find((a) => /aucune phase du dossier/.test(a))!
    expect(message).toMatch(/rouge en permanence/)
    expect(message).toContain('Rue du Docteur Masourenok')
    expect(message).toContain('Rue de la Croix Borne')
    expect(message).toMatch(/dossier est bien celui de ce carrefour/)
  })

  it('ne dit rien quand toutes les approches du carrefour sont ouvertes', () => {
    const res = appliquer(dossierQuatreBranches(), 'c', reseauAvenueNordSud())
    expect(res.avertissements.some((a) => /aucune phase du dossier/.test(a))).toBe(false)
  })

  it('laisse les mouvements en commun quand le dossier ne cite aucun côté', () => {
    const dossier = dossierQuatreBranches()
    const groupes = dossier.groupes as Record<string, unknown>[]
    groupes[2].voie = 'Avenue de la Libération (D1082)'
    groupes[6].voie = 'Avenue de la Libération (D1082)'
    const sansCote = appliquer(dossier, 'c', reseauAvenueNordSud())
    const v3 = sansCote.controller!.groups!.find((g) => g.id === 'V3')!
    const v7 = sansCote.controller!.groups!.find((g) => g.id === 'V7')!
    expect(v3.movements).toEqual(v7.movements)
    expect(sansCote.avertissements.some((a) => /V3, V7 : même voie/.test(a) && /identiques/.test(a))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  Robustesse                                                         */
/* ------------------------------------------------------------------ */

describe('fichiers illisibles', () => {
  const vide = { controller: null, groupesRattaches: 0, groupesNonRattaches: [] }

  it('refuse un JSON invalide sans lever d’exception', () => {
    const res = appliquer('{"id": "VE00')
    expect(res).toMatchObject(vide)
    expect(res.avertissements[0]).toMatch(/JSON valide/)
  })

  it('refuse un contenu vide', () => {
    expect(appliquer('').avertissements[0]).toMatch(/vide/)
    expect(appliquer(null).avertissements[0]).toMatch(/Aucun contenu/)
    expect(appliquer(undefined).avertissements[0]).toMatch(/Aucun contenu/)
  })

  it('refuse un fichier d’un tout autre format', () => {
    expect(appliquer(42).avertissements[0]).toMatch(/pas un objet JSON/)
    expect(appliquer({ elements: [{ type: 'node', id: 1 }] }).avertissements[0])
      .toMatch(/ne décrit aucun dossier de carrefour/)
    expect(appliquer({ carrefours: [1, 'deux', null] }).avertissements[0]).toMatch(/aucun dossier/)
  })

  it('ne lève rien sur des champs de types inattendus', () => {
    const bancal = {
      id: 'X1',
      nom: 'Avenue de la Libération / Rue de la Croix de Borne',
      voies: 'Avenue de la Libération, Rue de la Croix de Borne',
      groupes: 'oui',
      phases: 42,
      plans_de_feux: { nom: 'PF1' },
      calendrier: 'lundi',
      matrice_inter_verts: [],
    }
    let res!: DossierImportResult
    expect(() => { res = appliquer(bancal) }).not.toThrow()
    expect(res.dossierId).toBe('X1')
    expect(res.avertissements.some((a) => /aucune phase/i.test(a))).toBe(true)
  })

  it('ne laisse pas un dossier illisible modifier le carrefour', () => {
    const boucle: Record<string, unknown> = { nom: 'Phase C', vehicules: ['V1'], mini_s: 5 }
    boucle.prolongation = boucle // structure circulaire : illisible
    const casse = ve005()
    ;(casse.phases as unknown[]).push(boucle)
    const res = appliquer(casse)
    expect(res.controller).toBeNull()
    expect(res.avertissements.join(' ')).toMatch(/converti/)
  })
})

/* ------------------------------------------------------------------ */
/*  Clés du fichier employées comme index d'objet                      */
/* ------------------------------------------------------------------ */

describe('clés de fichier réservées', () => {
  it('n’écrit jamais sur Object.prototype à partir d’une ligne de matrice nommée __proto__', () => {
    const dossier = ve005()
    // JSON.parse reproduit exactement la lecture d'un fichier : « __proto__ » y devient une propriété
    // propre, visible d'Object.entries, et l'indexation naïve écrirait alors sur Object.prototype.
    dossier.matrice_inter_verts = JSON.parse(
      '{"groupes":["V1","P2"],"valeurs":{"__proto__":{"pollue":42},"V1":{"P2":5,"constructor":9}},'
      + '"valeur_jaune_s":{"V1":3,"__proto__":7}}',
    )
    const res = appliquer(dossier)
    const temoin = {} as Record<string, unknown>
    expect(temoin.pollue).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'pollue')).toBe(false)
    const c5 = res.controller!
    expect(Object.keys(c5.interGreen ?? {})).toEqual(['V1'])
    expect(c5.interGreen?.V1).toEqual({ P2: 5 })
    expect(c5.amberByGroup).toEqual({ V1: 3 })
    expect(res.avertissements.some((a) => a.includes('__proto__') && a.includes('constructor'))).toBe(true)
    // Un import suivant ne doit pas hériter de la contamination du premier.
    const c6 = appliquer(ve006(), 'cJou').controller!
    expect(c6.interGreen?.V1?.V2).toBe(6)
    expect(c6.interGreen?.V1?.pollue).toBeUndefined()
  })

  it('ne prend pas un mot de voie pour une propriété héritée du dictionnaire d’abréviations', () => {
    expect(normaliserVoie('Rue Constructor')?.noyau).toBe('constructor')
  })
})

/* ------------------------------------------------------------------ */
/*  Type des groupes                                                   */
/* ------------------------------------------------------------------ */

describe('type des groupes', () => {
  it('reconnaît les écritures usuelles du type', () => {
    expect(typeDeGroupeDeclare('traversée piétonne')).toBe('pieton')
    expect(typeDeGroupeDeclare('TP')).toBe('pieton')
    expect(typeDeGroupeDeclare('Piétons')).toBe('pieton')
    expect(typeDeGroupeDeclare('véhicules')).toBe('vehicule')
    expect(typeDeGroupeDeclare('signal R25')).toBeNull()
  })

  it('traite en piéton un groupe dont le type ne commence pas par « pieton »', () => {
    const dossier = ve005()
    const groupes = dossier.groupes as Record<string, unknown>[]
    groupes[1].type = 'traversée piétonne'
    groupes[3].type = 'TP'
    const res = appliquer(dossier)
    const c = res.controller!
    expect(c.groups?.map((g) => `${g.id}:${g.type}`)).toEqual(['V1:vehicule', 'P2:pieton', 'V3:vehicule', 'P4:pieton'])
    // Pris pour un groupe véhicule, P4 ouvrirait au vert protégé les mouvements qui arrivent de la Croix
    // de Borne — en conflit avec la Libération — au lieu de se contenter de retirer la protection.
    expect(Object.keys(c.phases[0].movements).some((k) => /^[ns]Borne_/.test(k))).toBe(false)
    expect(Object.keys(c.phases[0].movements).sort()).toEqual([
      'cJou_cLib>cLib_nBorne', 'cJou_cLib>cLib_sBorne', 'cJou_cLib>cLib_w',
      'w_cLib>cLib_cJou', 'w_cLib>cLib_nBorne', 'w_cLib>cLib_sBorne',
    ])
  })

  it('se rabat sur le préfixe de l’identifiant quand le type est renseigné mais illisible, et le dit', () => {
    const dossier = ve005()
    ;(dossier.groupes as Record<string, unknown>[])[1].type = 'signal R25'
    const res = appliquer(dossier)
    const c = res.controller!
    expect(c.groups!.find((g) => g.id === 'P2')!.type).toBe('pieton')
    expect(res.avertissements.some((a) => /Groupe P2/.test(a) && /non reconnu/.test(a))).toBe(true)
  })

  it('signale deux groupes de même identifiant', () => {
    const dossier = ve005()
    ;(dossier.groupes as Record<string, unknown>[]).push({ id: 'V1', type: 'vehicule', voie: 'Rue de la Croix de Borne' })
    const res = appliquer(dossier)
    expect(res.avertissements.some((a) => /identifiant « V1 »/.test(a))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  Formes inattendues des clés du dossier                             */
/* ------------------------------------------------------------------ */

describe('formes inattendues du dossier', () => {
  it('lit une matrice d’inter-verts donnée en tableau de lignes et dit ce qu’elle a fait', () => {
    const dossier = ve005()
    dossier.matrice_inter_verts = {
      groupes: ['V1', 'P2', 'V3', 'P4'],
      valeurs: [
        { groupe: 'V1', valeurs: { P2: 5, V3: 6 } },
        { groupe: 'P2', V1: 5 },
        { groupe: 'V3', valeurs: { V1: 6, P4: 5 } },
        { groupe: 'P4', V3: 5 },
      ],
      valeur_jaune_s: { V1: 3, V3: 3 },
    }
    const res = appliquer(dossier)
    const c = res.controller!
    expect(c.interGreen?.V1?.P2).toBe(5)
    expect(c.interGreen?.P2?.V1).toBe(5)
    expect(c.amberByGroup).toEqual({ V1: 3, V3: 3 })
    expect(res.avertissements.some((a) => /tableau de lignes/.test(a))).toBe(true)
  })

  it('dit ce qui s’applique à la place quand la matrice est d’une forme illisible', () => {
    const dossier = ve005()
    dossier.matrice_inter_verts = 'voir page 12 du dossier'
    const res = appliquer(dossier)
    const c = res.controller!
    expect(c.interGreen).toBeUndefined()
    expect(res.avertissements.some((a) => /inter-verts/.test(a) && /rouge intégral par défaut/.test(a)))
      .toBe(true)
  })

  it('lit un plan de feux unique donné en objet plutôt qu’en tableau', () => {
    const dossier = ve005()
    dossier.plans_de_feux = {
      nom: 'PF1',
      periode: 'Permanent',
      cycle_s: 74,
      phases: [{ nom: 'Phase A Repos', mini_s: 15, maxi_s: 40 }, { nom: 'Phase B', mini_s: 10, maxi_s: 25 }],
    }
    dossier.calendrier = null
    const res = appliquer(dossier)
    const c = res.controller!
    expect(c.plans?.map((p) => [p.name, p.cycle])).toEqual([['PF1', 74]])
    expect(res.avertissements.some((a) => /objet et non une liste/.test(a))).toBe(true)
  })

  it('avertit quand « plans_de_feux » est d’une forme illisible', () => {
    const dossier = ve005()
    dossier.plans_de_feux = 'PF1 et PF2'
    dossier.calendrier = null
    const res = appliquer(dossier)
    expect(res.controller!.plans).toBeUndefined()
    expect(res.avertissements.some((a) => /plans_de_feux/.test(a) && /texte/.test(a))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  Escamotage et prolongation                                         */
/* ------------------------------------------------------------------ */

describe('escamotage et prolongation', () => {
  it('n’escamote pas une phase seulement prolongée et signale la contradiction avec le mode cyclique', () => {
    const dossier = ve005()
    ;(dossier.phases as Record<string, unknown>[])[1].prolongation = 'B31, intervalle véhicule 2 s'
    const res = appliquer(dossier)
    const c = res.controller!
    expect(c.mode).toBe('actuated')
    // Une prolongation de vert n'est pas un escamotage : la phase s'ouvre à chaque cycle.
    expect(c.actuated.skipEmpty).toBe(false)
    expect(c.phases[1].gap).toBe(2)
    expect(res.avertissements.some((a) => /cyclique/.test(a) && /adaptatif/.test(a))).toBe(true)
  })

  it('escamote quand une phase est appelée sur détecteur', () => {
    const dossier = ve005()
    ;(dossier.phases as Record<string, unknown>[])[1].appel = ['B21']
    const res = appliquer(dossier)
    const c = res.controller!
    expect(c.mode).toBe('actuated')
    expect(c.actuated.skipEmpty).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  Rattachement des plans cités par le calendrier                     */
/* ------------------------------------------------------------------ */

describe('plans cités par le calendrier', () => {
  it('ne rattache pas « PF12 » au plan « PF1 »', () => {
    const dossier = ve005()
    dossier.calendrier = { lundi_vendredi: [{ plage: '06:00-09:00', plan: 'PF12' }] }
    const res = appliquer(dossier)
    expect(res.controller!.schedule).toBeUndefined()
    expect(res.avertissements.some((a) => /PF12/.test(a) && /inconnu/.test(a))).toBe(true)
  })

  it('rattache « PF 1 » à « PF1 » par égalité, sans parler de repli', () => {
    const dossier = ve005()
    dossier.calendrier = { lundi_vendredi: [{ plage: '06:00-09:00', plan: 'PF 1' }] }
    const res = appliquer(dossier)
    expect(res.controller!.schedule).toEqual([
      { planId: 'pf1', fromMin: 360, toMin: 540, days: [1, 2, 3, 4, 5] },
    ])
    expect(res.avertissements.some((a) => /rapprochement/.test(a))).toBe(false)
  })

  it('dit quand un plan n’est rattaché que par rapprochement de libellés', () => {
    const dossier = ve005()
    dossier.calendrier = { lundi_vendredi: [{ plage: '06:00-09:00', plan: 'PF1 bis' }] }
    const res = appliquer(dossier)
    expect(res.controller!.schedule![0].planId).toBe('pf1')
    expect(res.avertissements.some((a) => /rapprochement/.test(a) && /PF1 bis/.test(a))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  Détails du calendrier, des durées et des messages                  */
/* ------------------------------------------------------------------ */

describe('détails du calendrier et des durées', () => {
  it('lit toutes les tranches d’une plage qui en compte plusieurs', () => {
    expect(plagesDuTexte('07h00-09h00 et 16h30-19h00').plages).toEqual([[420, 540], [990, 1140]])
    const dossier = ve005()
    dossier.calendrier = { lundi_vendredi: [{ plage: '07h00-09h00 et 16h30-19h00', plan: 'PF1' }] }
    const res = appliquer(dossier)
    expect(res.controller!.schedule).toEqual([
      { planId: 'pf1', fromMin: 420, toMin: 540, days: [1, 2, 3, 4, 5] },
      { planId: 'pf1', fromMin: 990, toMin: 1140, days: [1, 2, 3, 4, 5] },
    ])
  })

  it('signale un type de jour non reconnu porté par la clé du calendrier', () => {
    const dossier = ve005()
    dossier.calendrier = { 'pendant les vacances scolaires': [{ plage: '06:00-09:00', plan: 'PF1' }] }
    const res = appliquer(dossier)
    expect(res.avertissements.some((a) => /vacances scolaires/.test(a) && /non reconnu/.test(a)))
      .toBe(true)
  })

  it('écarte une durée négative et un maxi inférieur au mini, en le disant', () => {
    const dossier = ve005()
    const phases = dossier.phases as Record<string, unknown>[]
    phases[0].mini_s = -5
    phases[1].maxi_s = 4
    delete dossier.plans_de_feux
    dossier.calendrier = null
    const res = appliquer(dossier)
    const c = res.controller!
    expect(c.phases[0].minGreen).toBe(DEFAULT_SIGNAL_TIMING.minGreen)
    expect(c.phases[0].green).toBe(DEFAULT_SIGNAL_TIMING.minGreen)
    // Le maximum est ramené au minimum, jamais en dessous.
    expect(c.phases[1].maxGreen).toBe(10)
    const avertissements = res.avertissements
    expect(avertissements.some((a) => /négative/.test(a))).toBe(true)
    expect(avertissements.some((a) => /inférieur au vert minimal/.test(a))).toBe(true)
  })

  it('distingue une phase sans approche d’une phase fermée par les traversées piétonnes', () => {
    const res = appliquer({
      id: 'VE007',
      nom: 'VE007 Jourcey / Libération',
      voies: ['Avenue de la Libération', 'Rue de Jourcey'],
      groupes: [
        { id: 'V1', type: 'vehicule', voie: 'Avenue de la Libération' },
        { id: 'V2', type: 'vehicule', voie: 'Rue du Bourg' },
      ],
      phases: [
        { nom: 'Phase A', vehicules: ['V1'], mini_s: 20, maxi_s: 45 },
        { nom: 'Phase B', vehicules: ['V2'], mini_s: 9, maxi_s: 22 },
      ],
    }, 'cJou')
    const avertissements = res.avertissements
    expect(avertissements.some((a) => /Phase B/.test(a) && /aucune approche/.test(a))).toBe(true)
    // Le dossier ne comporte aucun groupe piéton : parler de traversées enverrait sur une fausse piste.
    expect(avertissements.some((a) => /après prise en compte des traversées piétonnes/.test(a))).toBe(false)
  })

  it('cite le libellé du dossier, et non sa forme normalisée, pour une phase propre à un autre plan', () => {
    const dossier = ve005()
    ;(dossier.phases as Record<string, unknown>[]).push({
      nom: 'Phase C', plan: 'PF3', vehicules: ['V3'], mini_s: 5, maxi_s: 10,
    })
    const res = appliquer(dossier)
    const message = res.avertissements.find((a) => /n'appartient qu'au plan/.test(a))!
    expect(message).toContain('« PF3 »')
    expect(message).not.toContain('pf3')
  })
})

/* ------------------------------------------------------------------ */
/*  Défauts relevés sur le vrai fichier de la commune                  */
/* ------------------------------------------------------------------ */

describe('noms de phase cités par les plans de feux', () => {
  /**
   * Forme de la Place de l'Europe : les phases ne portent AUCUNE durée, tout vient des plans, qui les
   * citent sans le préfixe « Phase ». Non résolus, les trois plans retombent sur les durées par défaut
   * et deviennent indiscernables : le carrefour perd la différence entre pointe et heure creuse.
   */
  function sansDureeDePhase(): Record<string, unknown> {
    return {
      id: 'EUROPE',
      nom: "Place de l'Europe",
      voies: ["Place de l'Europe", 'Rue du Stade'],
      groupes: [
        { id: 'V1', type: 'vehicule', voie: "Place de l'Europe" },
        { id: 'V2', type: 'vehicule', voie: 'Rue du Stade' },
      ],
      phases: [
        { nom: 'Phase A', vehicules: ['V1'] },
        { nom: 'Phase B', vehicules: ['V2'] },
      ],
      plans_de_feux: [
        { nom: 'HPM', cycle_s: 100, phases: [{ nom: 'A', mini_s: 10, maxi_s: 31 }, { nom: 'B rappel', mini_s: 7, maxi_s: 24 }] },
        { nom: 'HC', cycle_s: 90, phases: [{ nom: 'A', mini_s: 12, maxi_s: 36 }, { nom: 'B rappel', mini_s: 7, maxi_s: 21 }] },
      ],
    }
  }

  it('retrouve « A Repos » derrière « Phase A Repos » et applique les mini/maxi du plan', () => {
    const res = appliquer(sansDureeDePhase(), 'cEurope', reseauEcritureOsm())
    expect(res.avertissements.some((a) => /introuvable dans la liste des phases/.test(a))).toBe(false)
    const c = res.controller!
    const [hpm, hc] = c.plans!
    // Sans la résolution, les deux plans porteraient les mêmes durées par défaut.
    expect(hpm.phases[c.phases[0].id].maxGreen).toBe(31)
    expect(hc.phases[c.phases[0].id].maxGreen).toBe(36)
    expect(hpm.phases[c.phases[0].id].minGreen).toBe(10)
    expect(hc.phases[c.phases[0].id].minGreen).toBe(12)
    // « B rappel » précise la phase « B » : le repli mot à mot la retrouve.
    expect(hpm.phases[c.phases[1].id].maxGreen).toBe(24)
    expect(hc.phases[c.phases[1].id].maxGreen).toBe(21)
  })

  it('préfère « Phase B escamotable » à « Phase B » quand le plan cite « B escam »', () => {
    const res = appliquer({
      id: 'VE00X',
      nom: 'Jourcey / Libération',
      voies: ['Avenue de la Libération', 'Rue de Jourcey'],
      groupes: [
        { id: 'V1', type: 'vehicule', voie: 'Avenue de la Libération' },
        { id: 'V2', type: 'vehicule', voie: 'Rue de Jourcey' },
      ],
      phases: [
        { nom: 'Phase A Repos', vehicules: ['V1'], mini_s: 10, maxi_s: 40 },
        { nom: 'Phase B', vehicules: ['V2'], mini_s: 5, maxi_s: 9 },
        { nom: 'Phase B escamotable', plan: 'PFN', vehicules: ['V2'], mini_s: 8, maxi_s: 15 },
      ],
      plans_de_feux: [{ nom: 'PFN', cycle_s: 67, phases: [{ nom: 'A Repos', mini_s: 10, maxi_s: 40 }, { nom: 'B escam', mini_s: 8, maxi_s: 22 }] }],
    }, 'cJou')
    const c = res.controller!
    const escamotable = c.phases.find((p) => p.name === 'Phase B escamotable')!
    const simple = c.phases.find((p) => p.name === 'Phase B')!
    const plan = c.plans![0]
    expect(plan.phases[escamotable.id].maxGreen).toBe(22)
    // La phase « B », propre à aucun plan, reste ouverte avec ses propres durées : le réglage « B escam »
    // ne doit pas lui être appliqué.
    expect(plan.phases[simple.id].maxGreen).toBe(9)
  })

  it('ne rattache toujours pas « Phase 12 » à « Phase 1 »', () => {
    const res = appliquer({
      id: 'VE00Y',
      nom: 'Jourcey / Libération',
      voies: ['Avenue de la Libération', 'Rue de Jourcey'],
      groupes: [
        { id: 'V1', type: 'vehicule', voie: 'Avenue de la Libération' },
        { id: 'V2', type: 'vehicule', voie: 'Rue de Jourcey' },
      ],
      phases: [
        { nom: 'Phase 1 Repos', vehicules: ['V1'], mini_s: 10, maxi_s: 40 },
        { nom: 'Phase 2', vehicules: ['V2'], mini_s: 5, maxi_s: 9 },
      ],
      plans_de_feux: [{ nom: 'PF1', cycle_s: 67, phases: [{ nom: 'Phase 12', mini_s: 30, maxi_s: 30 }, { nom: '1 Repos', mini_s: 11, maxi_s: 41 }] }],
    }, 'cJou')
    const avertissements = res.avertissements
    expect(avertissements.some((a) => /« Phase 12 »/.test(a) && /introuvable/.test(a))).toBe(true)
    const c = res.controller!
    // La citation « 1 Repos », elle, désigne bien « Phase 1 Repos » : le préfixe retiré des deux côtés suffit.
    expect(c.plans![0].phases[c.phases[0].id].maxGreen).toBe(41)
  })

  it('distingue « Phase A’ escamotable » de « Phase A escamotable » malgré l’apostrophe', () => {
    const res = appliquer({
      id: 'VE00Z',
      nom: 'Jourcey / Libération',
      voies: ['Avenue de la Libération', 'Rue de Jourcey'],
      groupes: [
        { id: 'V1', type: 'vehicule', voie: 'Avenue de la Libération' },
        { id: 'V2', type: 'vehicule', voie: 'Rue de Jourcey' },
      ],
      phases: [
        { nom: 'Phase A\u2019 escamotable', vehicules: ['V1'], mini_s: 5, maxi_s: 9 },
        { nom: 'Phase A escamotable', vehicules: ['V2'], mini_s: 5, maxi_s: 9 },
      ],
      plans_de_feux: [{
        nom: 'PF1',
        cycle_s: 80,
        phases: [{ nom: "A' escam", mini_s: 6, maxi_s: 12 }, { nom: 'A escam', mini_s: 7, maxi_s: 30 }],
      }],
    }, 'cJou')
    const c = res.controller!
    expect(c.plans![0].phases[c.phases[0].id].maxGreen).toBe(12)
    expect(c.plans![0].phases[c.phases[1].id].maxGreen).toBe(30)
    // Ces deux noms sont bien distincts : aucun avertissement d'homonymie ne doit être émis.
    expect(res.avertissements.some((a) => /indiscernables|le même nom/.test(a))).toBe(false)
  })
})

describe('plans cités par le calendrier dans un autre ordre', () => {
  function deuxPlansComposes(nomsCalendrier: [string, string]): Record<string, unknown> {
    return {
      id: 'VE004',
      nom: 'Marcel Pagnol / Saint-Bonnet',
      voies: ['Rue Marcel Pagnol', 'Route de Saint-Bonnet-les-Oules'],
      groupes: [
        { id: 'V1', type: 'vehicule', voie: 'Rue Marcel Pagnol' },
        { id: 'V2', type: 'vehicule', voie: 'Route de Saint-Bonnet-les-Oules' },
      ],
      phases: [
        { nom: 'Phase A', vehicules: ['V1'], mini_s: 10, maxi_s: 25 },
        { nom: 'Phase B', vehicules: ['V2'], mini_s: 10, maxi_s: 32 },
      ],
      plans_de_feux: [
        { nom: 'PF1 - STR1', cycle_s: 94, phases: [{ nom: 'A', mini_s: 10, maxi_s: 25 }, { nom: 'B', mini_s: 10, maxi_s: 32 }] },
        { nom: 'PF2 - STR2', cycle_s: 91, phases: [{ nom: 'A', mini_s: 10, maxi_s: 40 }, { nom: 'B', mini_s: 10, maxi_s: 32 }] },
      ],
      calendrier: {
        lundi_a_vendredi: [
          { plage: '06h30 - 09h00', plan: nomsCalendrier[0] },
          { plage: '09h00 - 15h30', plan: nomsCalendrier[1] },
        ],
      },
    }
  }

  it('reconnaît « STR1 - PF1 » comme le plan « PF1 - STR1 » et l’annonce comme un repli', () => {
    const res = appliquer(deuxPlansComposes(['STR1 - PF1', 'STR2 - PF2']), 'cPagnol')
    const c = res.controller!
    expect(c.schedule).toHaveLength(2)
    expect(c.schedule![0].planId).toBe(c.plans![0].id)
    expect(c.schedule![1].planId).toBe(c.plans![1].id)
    const avertissements = res.avertissements
    expect(avertissements.some((a) => /plan « STR1 - PF1 » inconnu/.test(a))).toBe(false)
    expect(avertissements.some((a) => /« STR1 - PF1 » → « PF1 - STR1 »/.test(a) && /repli|rapprochement/.test(a))).toBe(true)
  })

  it('garde l’égalité stricte silencieuse', () => {
    const res = appliquer(deuxPlansComposes(['PF1 - STR1', 'PF2 - STR2']), 'cPagnol')
    expect(res.avertissements.some((a) => /rapprochement de libellés/.test(a))).toBe(false)
  })

  it('refuse de trancher entre deux plans qui portent les mêmes mots', () => {
    // Deux plans du même jeu de mots ne se départagent pas : rattacher l'un des deux au hasard donnerait
    // au carrefour un cycle et des verts qui ne sont pas les siens, sans que rien ne le signale.
    const dossier = deuxPlansComposes(['STR1 - HPM - PF1', 'PF2 - STR2'])
    const plans = dossier.plans_de_feux as Record<string, unknown>[]
    plans[0].nom = 'PF1 - STR1 - HPM'
    plans[1].nom = 'HPM - PF1 - STR1'
    const res = appliquer(dossier, 'cPagnol')
    expect(res.avertissements.some((a) => /plan « STR1 - HPM - PF1 » inconnu/.test(a))).toBe(true)
  })
})

describe('colonne « jaune » donnée par catégorie de groupes', () => {
  function avecJaune(jaune: unknown): Record<string, unknown> {
    const dossier = ve005()
    ;(dossier.matrice_inter_verts as Record<string, unknown>).valeur_jaune_s = jaune
    return dossier
  }

  it('applique une valeur de catégorie à tous les groupes véhicules', () => {
    const res = appliquer(avecJaune({ vehicules: 3 }))
    const c = res.controller!
    // V1 et V3 sont les seuls groupes véhicules ; P2 et P4 n'ont pas de jaune.
    expect(c.amberByGroup).toEqual({ V1: 3, V3: 3 })
    expect(c.amber).toBe(3)
    expect(res.avertissements.some((a) => /« vehicules »/.test(a) && /catégorie/.test(a))).toBe(true)
  })

  it('accepte « VL », « voitures » et un nombre seul', () => {
    for (const jaune of [{ VL: 4 }, { voitures: 4 }, 4]) {
      const res = appliquer(avecJaune(jaune))
      expect(res.controller!.amberByGroup).toEqual({ V1: 4, V3: 4 })
    }
  })

  it('laisse la valeur nommée d’un groupe l’emporter sur celle de la catégorie', () => {
    const res = appliquer(avecJaune({ vehicules: 3, V3: 5 }))
    expect(res.controller!.amberByGroup).toEqual({ V1: 3, V3: 5 })
  })

  it('écarte une clé qui n’est ni un groupe ni une catégorie, et le dit', () => {
    const res = appliquer(avecJaune({ V1: 3, V9: 3 }))
    expect(res.controller!.amberByGroup).toEqual({ V1: 3 })
    expect(res.avertissements.some((a) => /« V9 »/.test(a) && /sans correspondance/.test(a))).toBe(true)
  })
})

describe('écarts d’écriture entre les noms de voies du dossier et ceux du réseau', () => {
  it('rapproche abréviation, prénom en trop, mot outil en trop et apostrophe typographique', () => {
    const cas: [string, string][] = [
      ['Rue du Dr Igor Masourenok', 'Rue du Docteur Masourenok'],
      ['Rue de la Croix de Borne', 'Rue de la Croix Borne'],
      ["Place de l'Europe", 'Place de l’Europe'],
      ['Rte de St Bonnet les Oules', 'Route de Saint-Bonnet-les-Oules'],
      ['Av. du Gal de Gaulle', 'Avenue du Général de Gaulle'],
      ['Bd Jean Jaurès', 'Boulevard Jean Jaurès'],
      ['Ch. des Granges', 'Chemin des Granges'],
      ['Imp. du Parc', 'Impasse du Parc'],
      ['Pl. Jacques Raffin', 'Place Jacques Raffin'],
    ]
    for (const [dossier, osm] of cas) {
      const a = normaliserVoie(dossier)
      const b = normaliserVoie(osm)
      expect(a && b && memeVoie(a, b), `${dossier} ≠ ${osm}`).toBe(true)
    }
  })

  it('garde distinctes deux voies réellement différentes', () => {
    const cas: [string, string][] = [
      ['Rue de la Croix des Pères', 'Rue de la Croix de Borne'],
      ['Rue de la Croix Borne', 'Rue de la Croix des Pères'],
      ['Avenue de la Libération', 'Avenue du Général de Gaulle'],
      ['Rue Marcel Pagnol', 'Rue Marcel Proust'],
      ['Lotissement la Plagne Est', 'Lotissement la Plagne Ouest'],
    ]
    for (const [x, y] of cas) {
      const a = normaliserVoie(x)
      const b = normaliserVoie(y)
      expect(a && b && memeVoie(a, b), `${x} = ${y}`).toBe(false)
    }
  })

  it('recolle la lettre et le numéro d’une route départementale écrite avec une espace', () => {
    expect(normaliserVoie('D 54')?.noyau).toBe('d54')
    expect(normaliserVoie('RD 1082')?.noyau).toBe('d1082')
  })

  it('rattache les groupes que ces seuls écarts d’écriture faisaient manquer', () => {
    const res = appliquer({
      id: 'VE005',
      nom: 'Croix de Borne / Général de Gaulle',
      voies: ['Avenue du Général de Gaulle (D1082)', 'Rue du Dr Igor Masourenok', 'Rue de la Croix de Borne'],
      groupes: [
        { id: 'V1', type: 'vehicule', voie: 'Rue du Dr Igor Masourenok' },
        { id: 'V3', type: 'vehicule', voie: 'Rue de la Croix de Borne' },
      ],
      phases: [
        { nom: 'Phase A Repos', vehicules: ['V1'], mini_s: 10, maxi_s: 40 },
        { nom: 'Phase B', vehicules: ['V3'], mini_s: 8, maxi_s: 15 },
      ],
    }, 'c', reseauEcritureOsm())
    // Le réseau écrit « Rue du Docteur Masourenok » et « Rue de la Croix Borne » : les deux groupes
    // doivent tout de même retrouver leurs mouvements.
    expect(res.groupesNonRattaches).toEqual([])
    expect(res.groupesRattaches).toBe(2)
  })
})

describe('voie désignée par sa référence routière', () => {
  function dossierRD(voies: string[]): Record<string, unknown> {
    return {
      id: 'RD1082/CHEMIN DES GRANGES',
      nom: 'RD 1082 / Croix Borne',
      voies,
      groupes: [
        { id: 'V1', type: 'vehicule', voie: 'RD 1082, arrivée est' },
        { id: 'V3', type: 'vehicule', voie: 'Rue de la Croix Borne (branche sud)' },
      ],
      phases: [
        { nom: 'Phase A Repos', vehicules: ['V1'], mini_s: 10, maxi_s: 40 },
        { nom: 'Phase B', vehicules: ['V3'], mini_s: 8, maxi_s: 15 },
      ],
    }
  }

  it('rapproche « RD 1082 » du nom que le dossier lui donne entre parenthèses, et le dit', () => {
    const res = appliquer(
      dossierRD(['Avenue du Général de Gaulle (D1082)', 'Rue de la Croix Borne']), 'c', reseauEcritureOsm(),
    )
    expect(res.groupesNonRattaches).toEqual([])
    expect(res.avertissements.some((a) => /« RD 1082 » → « Avenue du Général de Gaulle »/.test(a))).toBe(true)
  })

  it('laisse le groupe non rattaché et nomme la cause exacte quand rien ne nomme la référence', () => {
    const res = appliquer(dossierRD(['RD 1082', 'Rue de la Croix Borne']), 'c', reseauEcritureOsm())
    expect(res.groupesNonRattaches).toContain('V1')
    const cause = res.avertissements.find((a) => /référence routière/.test(a))!
    expect(cause).toContain('V1')
    expect(cause).toMatch(/ne retient que le nom des voies/)
    // Ce n'est pas un problème de géométrie de traversée piétonne : ne pas y envoyer le technicien.
    expect(cause).not.toMatch(/traversée/)
  })
})

/* ------------------------------------------------------------------ */
/*  Traversées piétonnes concomitantes (§14.5)                         */
/* ------------------------------------------------------------------ */

describe('phase dont tous les mouvements franchissent une traversée verte', () => {
  /**
   * VE004 augmenté d'une traversée de la Rue Marcel Pagnol, verte avec la Route de Saint-Bonnet : le motif
   * du carrefour VE004 réel de Veauche, dont la phase B n'ouvre qu'une branche en T. Les deux mouvements
   * de cette branche débouchent sur la voie traversée, tous deux sont donc en cession.
   */
  function ve004AvecTraversee(): Record<string, unknown> {
    const dossier = ve004()
    ;(dossier.groupes as unknown[]).push({ id: 'P3', type: 'pieton', voie: 'Traversée Rue Marcel Pagnol' })
    ;(dossier.phases as Record<string, unknown>[])[1].pietons = ['P3']
    return dossier
  }
  const res = appliquer(ve004AvecTraversee(), 'cPagnol')
  const c = res.controller!
  const phaseB = c.phases[1]

  it('garde ces mouvements au vert et n’annonce plus une phase sans vert', () => {
    expect(phaseB.groups).toEqual(['V2', 'P3'])
    expect(Object.keys(phaseB.movements).sort()).toEqual(['eBonnet_cPagnol>cPagnol_nPagnol', 'eBonnet_cPagnol>cPagnol_sPagnol'])
    // Ce que simule le moteur : deux verts permis, aucun rouge. L'ancien message parlait d'une phase sans
    // aucun mouvement au vert, ce qui envoyait l'exploitant chercher un défaut inexistant.
    expect(Object.values(phaseMovements(c, phaseB)).sort()).toEqual(['permitted', 'permitted'])
    expect(res.avertissements.some((a) => /aucun mouvement au vert/.test(a))).toBe(false)
  })

  it('avertit que la phase n’ouvre aucun vert protégé et que sa capacité est optimiste', () => {
    const a = res.avertissements.find((x) => x.startsWith('Phase « Phase B escamotable »'))!
    expect(a).toMatch(/tous franchis par une traversée piétonne verte/)
    // La traversée en cause est nommée : c'est par elle que l'exploitant remonte au dossier.
    expect(a).toContain('P3')
    expect(a).toMatch(/aucun vert protégé/)
    expect(a).toMatch(/optimiste/)
    // P3 est sur bouton poussoir : la cession ne vaut que les cycles où la traversée est appelée.
    expect(a).toMatch(/bouton poussoir \(P3\)/)
    // La phase A, elle, n'a pas de traversée concomitante : rien ne doit être dit à son sujet.
    expect(res.avertissements.some((x) => x.startsWith('Phase « Phase A Repos »'))).toBe(false)
  })

  it('ne parle de bouton poussoir que pour une traversée qui n’est pas en rappel', () => {
    const dossier = ve004AvecTraversee()
    ;(dossier.phases as Record<string, unknown>[])[1].pietons_en_rappel = true
    const autre = appliquer(dossier, 'cPagnol')
    const a = autre.avertissements.find((x) => x.startsWith('Phase « Phase B escamotable »'))!
    expect(a).toMatch(/tous franchis par une traversée piétonne verte/)
    expect(a).not.toMatch(/bouton poussoir/)
  })

  it('ne nomme que les traversées qui franchissent réellement un mouvement ouvert', () => {
    const dossier = ve004AvecTraversee()
    // P5 traverse une voie absente de ce carrefour : elle ne franchit aucun mouvement, la citer
    // enverrait l'exploitant vérifier une traversée qui n'y est pour rien.
    ;(dossier.groupes as unknown[]).push({ id: 'P5', type: 'pieton', voie: 'Traversée Rue du Stade' })
    ;(dossier.phases as Record<string, unknown>[])[1].pietons = ['P3', 'P5']
    const autre = appliquer(dossier, 'cPagnol')
    const a = autre.avertissements.find((x) => x.startsWith('Phase « Phase B escamotable »'))!
    expect(a).toContain('P3')
    expect(a).not.toContain('P5')
  })
})
