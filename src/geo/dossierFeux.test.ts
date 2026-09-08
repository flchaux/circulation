/**
 * Import des dossiers de carrefour.
 *
 * Le fichier réel de la commune n'étant pas disponible ici, les fixtures sont écrites à partir du format
 * documenté (docs/ARCHITECTURE.md §14 et la documentation du fichier `veauche_feux_tricolores.json`) et
 * reprennent ses valeurs vérifiables : VE005, plan PF1, phase A Repos, maxi_s = 40 ;
 * `matrice_inter_verts.valeurs.V1.P2` = 5.
 */
import { describe, expect, it } from 'vitest'
import type { NetEdge, NetNode, Network, NodeId } from '@/model/types'
import { DEFAULT_SIGNAL_TIMING } from '@/model/defaults'
import { phaseMovements, validateController } from '@/model/signals'
import {
  heureEnMinutes, heuresDuTexte, importDossiersFeux, joursDuLibelle, memeVoie, normaliserVoie,
  plagesDuTexte, typeDeGroupeDeclare,
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
const opts = { network: reseau }

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

describe('import d’une fixture à deux carrefours', () => {
  const res = importDossiersFeux(fichier(ve005(), ve006()), opts)
  const m5 = res.matches.find((m) => m.dossierId === 'VE005')!
  const m6 = res.matches.find((m) => m.dossierId === 'VE006')!
  const c5 = res.controllers[m5.controllerId!]
  const c6 = res.controllers[m6.controllerId!]

  it('rattache les deux dossiers et passe les nœuds en feux', () => {
    expect(res.matches).toHaveLength(2)
    expect(m5.nodeId).toBe('cLib')
    expect(m6.nodeId).toBe('cJou')
    expect(res.controls.cLib).toEqual({ nodeId: 'cLib', type: 'signals', controllerId: m5.controllerId })
    expect(res.controls.cJou.type).toBe('signals')
    expect(Object.keys(res.controllers)).toHaveLength(2)
    expect(res.avertissements).toEqual([])
  })

  it('reprend les groupes, leur type et les mouvements de chaque approche', () => {
    expect(c5.source).toBe('dossier VE005')
    expect(c5.groups?.map((g) => `${g.id}:${g.type}`)).toEqual(['V1:vehicule', 'P2:pieton', 'V3:vehicule', 'P4:pieton'])
    const v1 = c5.groups!.find((g) => g.id === 'V1')!
    // V1 commande les deux approches de l'Avenue de la Libération, soit trois mouvements chacune.
    expect(v1.movements).toHaveLength(6)
    expect(v1.movements).toContain('w_cLib>cLib_cJou')
    expect(v1.label).toBe('Avenue de la Libération')
    expect(m5.groupesRattaches).toBe(4)
    expect(m5.groupesNonRattaches).toEqual([])
  })

  it('donne au groupe piéton les mouvements qui franchissent sa traversée, et le signale', () => {
    const p2 = c5.groups!.find((g) => g.id === 'P2')!
    // P2 traverse l'Avenue de la Libération : tout mouvement qui y entre ou en sort la franchit.
    expect(p2.movements).toContain('w_cLib>cLib_cJou')
    expect(p2.movements).toContain('nBorne_cLib>cLib_w')
    expect(p2.movements).not.toContain('nBorne_cLib>cLib_sBorne')
    expect(m5.avertissements.some((a) => /traversée/i.test(a) && /géométrie/i.test(a))).toBe(true)
    // Ces mouvements ne sont pas « interdits » par la traversée (§14.5) : l'avertissement ne doit pas
    // laisser croire à l'exploitant qu'un rattachement de trop ferme une branche du carrefour.
    expect(m5.avertissements.some((a) => /mouvements interdits/i.test(a))).toBe(false)
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
    const texte = JSON.stringify(res)
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
/*  Rattachement                                                       */
/* ------------------------------------------------------------------ */

describe('rattachement au réseau', () => {
  it('est sûr quand au moins deux voies concordent, malgré les abréviations', () => {
    const res = importDossiersFeux(fichier(ve004()), opts)
    const m = res.matches[0]
    expect(m.confiance).toBe('sure')
    expect(m.nodeId).toBe('cPagnol')
    expect(m.raison).toMatch(/2 voies/)
    expect(m.raison).toContain('Rue Marcel Pagnol')
  })

  it('est probable quand une seule voie concorde', () => {
    const res = importDossiersFeux(fichier({
      id: 'Place de l’Europe',
      nom: "Place de l'Europe",
      voies_plan: ["Place de l'Europe", 'Rue des Tilleuls'],
      groupes: [{ id: 'V1', type: 'vehicule', voie: "Place de l'Europe", source_voie: 'lecture du plan' }],
      phases: [{ nom: 'Phase A', vehicules: ['V1'], mini_s: 10, maxi_s: 30 }],
    }), opts)
    const m = res.matches[0]
    expect(m.confiance).toBe('probable')
    expect(m.nodeId).toBe('cEurope')
    expect(m.raison).toMatch(/une seule voie/)
    // Une voie reconstituée par lecture du plan doit être confirmée par l'exploitant (§6 du format).
    expect(m.avertissements.some((a) => /source_voie/.test(a))).toBe(true)
  })

  it('renonce quand aucune voie du dossier n’existe dans le réseau', () => {
    const res = importDossiersFeux(fichier({
      id: 'Chemin des Granges',
      nom: 'RD 1082 / Chemin des Granges',
      voies_plan: ['RD 1082', 'Chemin des Granges'],
      groupes: [{ id: 'V1', type: 'vehicule', voie: 'RD 1082' }],
      phases: [{ nom: 'Phase A', vehicules: ['V1'], mini_s: 10, maxi_s: 30 }],
    }), opts)
    const m = res.matches[0]
    expect(m.confiance).toBe('aucune')
    expect(m.nodeId).toBeNull()
    expect(m.controllerId).toBeNull()
    expect(m.raison).toMatch(/aucune des voies/)
    expect(m.groupesNonRattaches).toEqual(['V1'])
    expect(res.controllers).toEqual({})
    expect(res.controls).toEqual({})
  })

  it('renonce plutôt que de trancher entre deux carrefours aussi plausibles', () => {
    const res = importDossiersFeux(fichier({
      id: 'VE999',
      nom: 'Carrefour de la Libération',
      voies: ['Avenue de la Libération'],
      groupes: [{ id: 'V1', type: 'vehicule', voie: 'Avenue de la Libération' }],
      phases: [{ nom: 'Phase A', vehicules: ['V1'], mini_s: 10, maxi_s: 30 }],
    }), opts)
    const m = res.matches[0]
    expect(m.confiance).toBe('incertaine')
    expect(m.nodeId).toBeNull()
    expect(m.raison).toMatch(/2 carrefours/)
  })

  it('laisse de côté le dossier le moins bien reconnu quand deux revendiquent le même carrefour', () => {
    const res = importDossiersFeux(fichier(ve005(), {
      id: 'VE998',
      nom: 'Croix de Borne',
      voies: ['Rue de la Croix de Borne'],
      groupes: [{ id: 'V1', type: 'vehicule', voie: 'Rue de la Croix de Borne' }],
      phases: [{ nom: 'Phase A', vehicules: ['V1'], mini_s: 10, maxi_s: 30 }],
    }), opts)
    expect(res.matches.find((m) => m.dossierId === 'VE005')!.confiance).toBe('sure')
    const perdant = res.matches.find((m) => m.dossierId === 'VE998')!
    expect(perdant.confiance).toBe('incertaine')
    expect(perdant.nodeId).toBeNull()
    expect(perdant.raison).toContain('VE005')
    expect(Object.keys(res.controllers)).toHaveLength(1)
  })

  it('réutilise le contrôleur existant du carrefour au lieu d’en créer un second', () => {
    const avecFeux: Network = {
      ...reseau,
      controls: { ...reseau.controls, cLib: { nodeId: 'cLib', type: 'signals', controllerId: 'c42' } },
      controllers: {
        c42: {
          id: 'c42', name: 'Carrefour à feux', nodeIds: ['cLib'], mode: 'fixed', offset: 0,
          amber: 3, allRed: 2, phases: [], actuated: { skipEmpty: true },
        },
      },
    }
    const res = importDossiersFeux(fichier(ve005()), { network: avecFeux })
    expect(res.matches[0].controllerId).toBe('c42')
    expect(res.controllers.c42.source).toBe('dossier VE005')
  })
})

/* ------------------------------------------------------------------ */
/*  Score de rattachement : les rues du carrefour, pas les libellés     */
/* ------------------------------------------------------------------ */

/**
 * Le carrefour décalé du Chemin des Granges, tel qu'OpenStreetMap décrit celui de Veauche : deux nœuds
 * à cinquante mètres, dont aucun ne réunit les quatre branches du dossier.
 *  - `cVillemagne` ne voit arriver que la Rue Barthelemy Villemagne, par ses deux côtés ; le « Chemin des
 *    Granges » n'en est qu'une sortie, à sens unique, vers le carrefour voisin ;
 *  - `cGaulle` est le vrai carrefour : l'avenue (la RD 1082, qu'OSM ne nomme jamais par sa référence)
 *    et le Chemin des Granges.
 */
function reseauCarrefourDecale(): Network {
  const { noeud, branche, sensUnique, reseau } = constructeurReseau()
  noeud('cVillemagne', 0, 0)
  noeud('nVillemagne', 0, 200, true)
  noeud('sVillemagne', 0, -200, true)
  noeud('cGaulle', 55, -20)
  noeud('wGaulle', -145, -20, true)
  noeud('eGaulle', 255, -20, true)
  noeud('nGranges', 55, 180, true)
  branche('nVillemagne', 'cVillemagne', 'Rue Barthelemy Villemagne')
  branche('sVillemagne', 'cVillemagne', 'Rue Barthelemy Villemagne')
  sensUnique('cVillemagne', 'cGaulle', 'Chemin des Granges')
  branche('wGaulle', 'cGaulle', 'Avenue du Général de Gaulle')
  branche('eGaulle', 'cGaulle', 'Avenue du Général de Gaulle')
  branche('nGranges', 'cGaulle', 'Chemin des Granges')
  return reseau()
}

/** Le dossier « RD 1082 / Chemin des Granges » de Veauche, réduit à ce qui sert au rattachement. */
function granges(): Record<string, unknown> {
  return {
    id: 'RD1082/CHEMIN DES GRANGES',
    nom: 'RD 1082 / Chemin des Granges',
    voies: ['RD 1082', 'Chemin des Granges', 'Rue Barthélémy Villemagne'],
    groupes: [
      { id: 'V1', type: 'vehicule', voie: 'RD 1082, arrivée est' },
      { id: 'P2', type: 'pieton', voie: 'Traversée de la RD 1082, côté est' },
      { id: 'V3', type: 'vehicule', voie: 'Rue Barthélémy Villemagne (branche sud)' },
      { id: 'P4', type: 'pieton', voie: 'Traversée de la branche Villemagne' },
      { id: 'V7', type: 'vehicule', voie: 'Chemin des Granges (branche nord)' },
      { id: 'P8', type: 'pieton', voie: 'Traversée du Chemin des Granges' },
    ],
    phases: [
      { nom: 'Phase A', vehicules: ['V1'], pietons: ['P8'], mini_s: 10, maxi_s: 40 },
      { nom: 'Phase B', vehicules: ['V3', 'V7'], pietons: ['P2', 'P4'], mini_s: 8, maxi_s: 20 },
    ],
  }
}

describe('score de rattachement', () => {
  it('ne compte pas deux fois la rue qu’une traversée piétonne franchit', () => {
    const { noeud, branche, reseau } = constructeurReseau()
    noeud('cVillemagne', 0, 0)
    noeud('nVillemagne', 0, 200, true)
    noeud('sVillemagne', 0, -200, true)
    noeud('eLamartine', 200, 0, true)
    branche('nVillemagne', 'cVillemagne', 'Rue Barthelemy Villemagne')
    branche('sVillemagne', 'cVillemagne', 'Rue Barthelemy Villemagne')
    branche('eLamartine', 'cVillemagne', 'Rue Lamartine')
    const res = importDossiersFeux(fichier({
      id: 'RD1082/CHEMIN DES GRANGES',
      nom: 'RD 1082 / Chemin des Granges',
      voies: ['Rue Barthélémy Villemagne'],
      groupes: [
        { id: 'V3', type: 'vehicule', voie: 'Rue Barthélémy Villemagne (branche sud)' },
        { id: 'P4', type: 'pieton', voie: 'Traversée de la branche Villemagne' },
      ],
      phases: [{ nom: 'Phase A', vehicules: ['V3'], pietons: ['P4'], mini_s: 10, maxi_s: 30 }],
    }), { network: reseau() })
    const m = res.matches[0]
    expect(m.nodeId).toBe('cVillemagne')
    // Une seule rue du carrefour est nommée par le dossier, écrite deux fois : le rattachement reste
    // à confirmer. Comptée deux fois, elle donnerait une certitude qu'aucune donnée ne soutient.
    expect(m.confiance).toBe('probable')
    expect(m.raison).toMatch(/une seule voie/)
    expect(m.raison).toContain('Rue Barthelemy Villemagne')
    expect(m.raison).not.toContain('branche Villemagne')
    expect(m.raison).toContain('sur 2 rues qui y arrivent')
  })

  it('ne compte pas comme rue du carrefour celle qu’on ne fait qu’en partir', () => {
    // Dossier sans traversées : seul le sens unique sortant peut encore gonfler le score du voisin.
    const dossier = granges()
    dossier.groupes = (dossier.groupes as Record<string, unknown>[]).filter((g) => g.type !== 'pieton')
    dossier.phases = [{ nom: 'Phase A', vehicules: ['V1'], mini_s: 10, maxi_s: 40 }, { nom: 'Phase B', vehicules: ['V3', 'V7'], mini_s: 8, maxi_s: 20 }]
    const res = importDossiersFeux(fichier(dossier), { network: reseauCarrefourDecale() })
    const m = res.matches[0]
    // Le Chemin des Granges part de « cVillemagne » sans y arriver : ce nœud ne porte qu'une rue du dossier.
    expect(m.confiance).toBe('incertaine')
    expect(m.nodeId).toBeNull()
    expect(m.raison).toMatch(/2 carrefours/)
  })

  it('ne pose pas un plan de feux, avec certitude, sur le voisin du carrefour décrit', () => {
    const res = importDossiersFeux(fichier(granges()), { network: reseauCarrefourDecale() })
    const m = res.matches[0]
    // Aucun des deux nœuds du carrefour décalé ne réunit les branches du dossier : l'exploitant tranchera.
    expect(m.confiance).not.toBe('sure')
    expect(m.nodeId).toBeNull()
    expect(m.raison).toMatch(/2 carrefours/)
    expect(res.controllers).toEqual({})
    expect(res.controls).toEqual({})
  })

  it('n’énumère que les rues du nœud retenu, dans l’écriture du réseau', () => {
    const res = importDossiersFeux(fichier({
      id: 'VE005',
      nom: 'Croix de Borne / Masourenok',
      voies: ['Rue du Dr Igor Masourenok', 'Rue de la Croix de Borne'],
      groupes: [
        { id: 'V1', type: 'vehicule', voie: 'Rue du Dr Igor Masourenok' },
        { id: 'P2', type: 'pieton', voie: 'Traversée Rue du Dr Igor Masourenok' },
        { id: 'V3', type: 'vehicule', voie: 'Rue de la Croix de Borne' },
      ],
      phases: [
        { nom: 'Phase A', vehicules: ['V1'], mini_s: 10, maxi_s: 40 },
        { nom: 'Phase B', vehicules: ['V3'], pietons: ['P2'], mini_s: 8, maxi_s: 15 },
      ],
    }), { network: reseauEcritureOsm() })
    const m = res.matches[0]
    expect(m.nodeId).toBe('c')
    // Le message doit nommer les rues du carrefour, l'écriture du dossier n'étant qu'un rappel :
    // citer les libellés du dossier laisse croire qu'ils ont tous été retrouvés au nœud retenu.
    expect(m.raison).toContain('Rue du Docteur Masourenok (dossier : Rue du Dr Igor Masourenok)')
    expect(m.raison).toContain('Rue de la Croix Borne (dossier : Rue de la Croix de Borne)')
    // L'avenue du carrefour n'est pas au dossier : le message dit combien de rues y arrivent en tout.
    expect(m.raison).toContain('sur 3 rues qui y arrivent')
    expect(m.raison).not.toContain('Traversée')
  })

  it('préfère, à nombre égal de rues, le carrefour dont les rues portent des groupes de feux', () => {
    const { noeud, branche, reseau } = constructeurReseau()
    // Le carrefour du dossier, puis l'entrée du lotissement 200 m à l'est, sur la même route.
    noeud('cPagnol', 0, 0)
    noeud('wBonnet', -200, 0, true)
    noeud('nPagnol', 0, 200, true)
    noeud('cSerins', 200, 0)
    noeud('eBonnet', 400, 0, true)
    noeud('sSerins', 200, -200, true)
    branche('wBonnet', 'cPagnol', 'Route de Saint-Bonnet-les-Oules')
    branche('nPagnol', 'cPagnol', 'Rue Marcel Pagnol')
    branche('cPagnol', 'cSerins', 'Route de Saint-Bonnet-les-Oules')
    branche('cSerins', 'eBonnet', 'Route de Saint-Bonnet-les-Oules')
    branche('sSerins', 'cSerins', 'Lotissement les Serins')
    const res = importDossiersFeux(fichier(ve004Reel()), { network: reseau() })
    const m = res.matches[0]
    // Les deux nœuds portent deux voies du dossier ; seul le premier en a deux commandées par un groupe.
    expect(m.nodeId).toBe('cPagnol')
    expect(m.confiance).toBe('sure')
    // Les libellés de groupes commencent par « Voiture » et « Piéton » : ils doivent rester rattachables.
    expect(m.groupesNonRattaches).toEqual([])
    expect(m.groupesRattaches).toBe(5)
  })

  it('ne compte pas deux fois la route que le dossier nomme aussi par sa référence', () => {
    const { noeud, branche, reseau } = constructeurReseau()
    noeud('cPagnol', 0, 0)
    noeud('wBonnet', -200, 0, true)
    noeud('nPagnol', 0, 200, true)
    noeud('sBonnet', 0, -200, true)
    // Un nœud où la même route change d'écriture : « D 54 » d'un côté, son nom de l'autre.
    noeud('cD54', 600, 0)
    noeud('eD54', 800, 0, true)
    noeud('wD54', 400, 0, true)
    noeud('nBois', 600, 200, true)
    branche('wBonnet', 'cPagnol', 'Route de Saint-Bonnet-les-Oules')
    branche('sBonnet', 'cPagnol', 'Route de Saint-Bonnet-les-Oules')
    branche('nPagnol', 'cPagnol', 'Rue Marcel Pagnol')
    branche('wD54', 'cD54', 'Route de Saint-Bonnet-les-Oules')
    branche('eD54', 'cD54', 'D 54')
    branche('nBois', 'cD54', 'Chemin du Bois')
    const dossier = ve004Reel()
    // Le dossier désigne l'arrivée ouest par la référence de la route, l'arrivée est par son nom.
    ;(dossier.groupes as Record<string, unknown>[])[2].voie = 'D 54, arrivée ouest'
    const res = importDossiersFeux(fichier(dossier), { network: reseau() })
    const m = res.matches[0]
    // « D 54 » et « Route de Saint-Bonnet-les-Oules » sont la même route, le dossier le dit lui-même :
    // le nœud qui les porte toutes deux ne réunit qu'une rue et ne peut pas égaler le vrai carrefour.
    expect(m.nodeId).toBe('cPagnol')
    expect(m.confiance).toBe('sure')
  })

  it('ramène au même noyau une traversée et la rue qu’elle franchit', () => {
    // « Traversée », « Piéton » et « branche » sont des mots de type de voie : le nom propre seul subsiste.
    expect(normaliserVoie('Traversée de la branche Villemagne')?.noyau).toBe('villemagne')
    expect(normaliserVoie('Traversée du Chemin des Granges')?.noyau).toBe('granges')
    expect(normaliserVoie('Piéton Av. Général de Gaulle')?.noyau).toBe('general de gaulle')
    // Ce qui n'est pas un mot de type de voie reste au noyau : « Voiture … » n'est pas une traversée.
    expect(normaliserVoie('Voiture Rue Marcel Pagnol')?.noyau).toBe('voiture rue marcel pagnol')
    const traversee = normaliserVoie('Traversée de la branche Villemagne')!
    const rue = normaliserVoie('Rue Barthelemy Villemagne')!
    expect(memeVoie(traversee, rue)).toBe(true)
  })

  it('ne retient plus la traversée comme une voie distincte dans le bilan d’un dossier non rattaché', () => {
    const res = importDossiersFeux(fichier({
      id: 'VE900',
      nom: 'Carrefour d’une autre commune',
      voies: ['Rue Barthélémy Villemagne'],
      groupes: [
        { id: 'V1', type: 'vehicule', voie: 'Rue Barthélémy Villemagne' },
        { id: 'P2', type: 'pieton', voie: 'Traversée de la branche Villemagne' },
      ],
      phases: [{ nom: 'Phase A', vehicules: ['V1'], pietons: ['P2'], mini_s: 10, maxi_s: 30 }],
    }), opts)
    const m = res.matches[0]
    expect(m.confiance).toBe('aucune')
    // Le dossier ne nomme qu'une voie : l'annoncer deux fois ferait chercher une rue qui n'existe pas.
    expect(m.raison).toBe('aucune des voies du dossier (Rue Barthélémy Villemagne) ne correspond à un tronçon du réseau')
  })
})

/** VE004 tel que le dossier réel l'écrit : libellés de groupes préfixés « Voiture » et « Piéton ». */
function ve004Reel(): Record<string, unknown> {
  return {
    id: 'VE004',
    nom: 'Rue Marcel Pagnol / Route de Saint-Bonnet-les-Oules',
    voies: ['Route de Saint-Bonnet-les-Oules (D54)', 'Rue Marcel Pagnol', 'Lotissement les Serins'],
    groupes: [
      { id: 'V1', type: 'vehicule', voie: 'Voiture Route de Saint-Bonnet-les-Oules (arrivée est)' },
      { id: 'P2', type: 'pieton', voie: 'Piéton Route de Saint-Bonnet-les-Oules (traversée est)' },
      { id: 'V3', type: 'vehicule', voie: 'Voiture Route de Saint-Bonnet-les-Oules (arrivée ouest)' },
      { id: 'V5', type: 'vehicule', voie: 'Voiture Rue Marcel Pagnol (arrivée nord)' },
      { id: 'P6', type: 'pieton', voie: 'Piéton Rue Marcel Pagnol' },
    ],
    phases: [
      { nom: 'Phase A', vehicules: ['V1', 'V3'], pietons: ['P6'], mini_s: 12, maxi_s: 40 },
      { nom: 'Phase B', vehicules: ['V5'], pietons: ['P2'], mini_s: 8, maxi_s: 20 },
    ],
  }
}

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
    const res = importDossiersFeux(fichier(ve005()), opts)
    const c = res.controllers[res.matches[0].controllerId!]
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
    const res = importDossiersFeux(fichier(dossier), opts)
    const c = res.controllers[res.matches[0].controllerId!]
    expect(c.schedule).toEqual([
      { planId: 'pf1', fromMin: 390, toMin: 1200, days: [1, 2, 3, 4, 5] },
      { planId: 'pf2', fromMin: 600, toMin: 1080, days: [7] },
    ])
  })

  it('donne un calendrier vide quand le dossier n’en porte pas', () => {
    const res = importDossiersFeux(fichier(ve006()), opts)
    const c = res.controllers[res.matches[0].controllerId!]
    expect(c.schedule).toBeUndefined()
  })

  it('signale un plan inconnu du calendrier au lieu de l’inventer', () => {
    const dossier = ve005()
    dossier.calendrier = { lundi_vendredi: [{ plage: '06:00-09:00', plan: 'PF7' }] }
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.matches[0].avertissements.some((a) => /PF7/.test(a))).toBe(true)
    expect(res.controllers[res.matches[0].controllerId!].schedule).toBeUndefined()
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
    const res = importDossiersFeux(fichier(dossier), opts)
    const m = res.matches[0]
    const c = res.controllers[m.controllerId!]
    expect(m.avertissements.some((a) => /asym/i.test(a) && a.includes('V1 → P2'))).toBe(true)
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
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.matches[0].avertissements.some((a) => /V9/.test(a))).toBe(true)
  })

  it('signale une phase qui réunit deux groupes déclarés incompatibles', () => {
    const dossier = ve005()
    const phases = dossier.phases as Record<string, unknown>[]
    phases[0].pietons = ['P2'] // P2 traverse la Libération, que V1 emprunte
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.matches[0].avertissements.some((a) => /incompatibles/.test(a) && /V1/.test(a))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  Modes de fonctionnement                                            */
/* ------------------------------------------------------------------ */

describe('mode du contrôleur', () => {
  it('passe en adaptatif quand une phase est escamotable', () => {
    const res = importDossiersFeux(fichier(ve004()), opts)
    const c = res.controllers[res.matches[0].controllerId!]
    expect(c.mode).toBe('actuated')
    expect(c.actuated.skipEmpty).toBe(true)
    // L'intervalle véhicule annoncé par la prolongation devient le temps de prolongation de la phase.
    expect(c.phases[1].gap).toBe(2.5)
  })

  it('passe en adaptatif sur mention d’escamotage dans l’identification', () => {
    const dossier = ve006()
    dossier.identification = { mode_fonctionnement: { cyclique: false, escamotage: true, onde_verte: false } }
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.controllers[res.matches[0].controllerId!].mode).toBe('actuated')
  })
})

/* ------------------------------------------------------------------ */
/*  Robustesse                                                         */
/* ------------------------------------------------------------------ */

describe('fichiers illisibles', () => {
  const vide = { controllers: {}, controls: {}, matches: [] }

  it('refuse un JSON invalide sans lever d’exception', () => {
    const res = importDossiersFeux('{"carrefours": [', opts)
    expect(res).toMatchObject(vide)
    expect(res.avertissements[0]).toMatch(/JSON valide/)
  })

  it('refuse un contenu vide', () => {
    expect(importDossiersFeux('', opts).avertissements[0]).toMatch(/vide/)
    expect(importDossiersFeux(null, opts).avertissements[0]).toMatch(/Aucun contenu/)
    expect(importDossiersFeux(undefined, opts).avertissements[0]).toMatch(/Aucun contenu/)
  })

  it('refuse un fichier d’un tout autre format', () => {
    expect(importDossiersFeux(42, opts).avertissements[0]).toMatch(/pas un objet JSON/)
    expect(importDossiersFeux({ elements: [{ type: 'node', id: 1 }] }, opts).avertissements[0])
      .toMatch(/liste « carrefours »/)
    const res = importDossiersFeux({ carrefours: [1, 'deux', null] }, opts)
    expect(res.matches).toEqual([])
    expect(res.avertissements.join(' ')).toMatch(/ignorée/)
  })

  it('accepte une liste de carrefours donnée telle quelle', () => {
    const res = importDossiersFeux([ve005()], opts)
    expect(res.matches).toHaveLength(1)
    expect(res.matches[0].nodeId).toBe('cLib')
  })

  it('signale un nombre de dossiers annoncé qui ne correspond pas', () => {
    const brut = fichier(ve005()) as Record<string, unknown>
    brut.nombre_dossiers = 6
    const res = importDossiersFeux(brut, opts)
    expect(res.avertissements.some((a) => /annonce 6 dossier/.test(a))).toBe(true)
    expect(res.matches).toHaveLength(1)
  })

  it('ne lève rien sur des champs de types inattendus', () => {
    const bancal = {
      carrefours: [{
        id: 'X1',
        nom: 'Avenue de la Libération / Rue de la Croix de Borne',
        voies: 'Avenue de la Libération, Rue de la Croix de Borne',
        groupes: 'oui',
        phases: 42,
        plans_de_feux: { nom: 'PF1' },
        calendrier: 'lundi',
        matrice_inter_verts: [],
      }],
    }
    let res!: ReturnType<typeof importDossiersFeux>
    expect(() => { res = importDossiersFeux(bancal, opts) }).not.toThrow()
    expect(res.matches[0].nodeId).toBe('cLib')
    expect(res.matches[0].avertissements.some((a) => /aucune phase/i.test(a))).toBe(true)
  })

  it('isole un dossier illisible sans perdre les autres', () => {
    const boucle: Record<string, unknown> = { nom: 'Phase C', vehicules: ['V1'], mini_s: 5 }
    boucle.prolongation = boucle // structure circulaire : illisible
    const casse = ve004()
    ;(casse.phases as unknown[]).push(boucle)
    const res = importDossiersFeux(fichier(ve005(), casse), opts)
    expect(res.matches.find((m) => m.dossierId === 'VE005')!.nodeId).toBe('cLib')
    const perdu = res.matches.find((m) => m.dossierId === 'VE004')!
    expect(perdu.nodeId).toBeNull()
    expect(perdu.confiance).toBe('aucune')
    expect(perdu.avertissements.join(' ')).toMatch(/converti/)
  })

  it('ne rattache rien sur un réseau sans carrefour', () => {
    const desert: Network = { nodes: {}, edges: {}, controls: {}, controllers: {} }
    const res = importDossiersFeux(fichier(ve005()), { network: desert })
    expect(res.matches[0].confiance).toBe('aucune')
    expect(res.avertissements.some((a) => /aucun carrefour/.test(a))).toBe(true)
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
    const res = importDossiersFeux(fichier(dossier, ve006()), opts)
    const temoin = {} as Record<string, unknown>
    expect(temoin.pollue).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'pollue')).toBe(false)
    const m5 = res.matches.find((m) => m.dossierId === 'VE005')!
    const c5 = res.controllers[m5.controllerId!]
    expect(Object.keys(c5.interGreen ?? {})).toEqual(['V1'])
    expect(c5.interGreen?.V1).toEqual({ P2: 5 })
    expect(c5.amberByGroup).toEqual({ V1: 3 })
    expect(m5.avertissements.some((a) => a.includes('__proto__') && a.includes('constructor'))).toBe(true)
    // Le second dossier du même fichier ne doit pas hériter de la contamination du premier.
    const c6 = res.controllers[res.matches.find((m) => m.dossierId === 'VE006')!.controllerId!]
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
    const res = importDossiersFeux(fichier(dossier), opts)
    const c = res.controllers[res.matches[0].controllerId!]
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
    const res = importDossiersFeux(fichier(dossier), opts)
    const c = res.controllers[res.matches[0].controllerId!]
    expect(c.groups!.find((g) => g.id === 'P2')!.type).toBe('pieton')
    expect(res.matches[0].avertissements.some((a) => /Groupe P2/.test(a) && /non reconnu/.test(a))).toBe(true)
  })

  it('signale deux groupes de même identifiant', () => {
    const dossier = ve005()
    ;(dossier.groupes as Record<string, unknown>[]).push({ id: 'V1', type: 'vehicule', voie: 'Rue de la Croix de Borne' })
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.matches[0].avertissements.some((a) => /identifiant « V1 »/.test(a))).toBe(true)
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
    const res = importDossiersFeux(fichier(dossier), opts)
    const c = res.controllers[res.matches[0].controllerId!]
    expect(c.interGreen?.V1?.P2).toBe(5)
    expect(c.interGreen?.P2?.V1).toBe(5)
    expect(c.amberByGroup).toEqual({ V1: 3, V3: 3 })
    expect(res.matches[0].avertissements.some((a) => /tableau de lignes/.test(a))).toBe(true)
  })

  it('dit ce qui s’applique à la place quand la matrice est d’une forme illisible', () => {
    const dossier = ve005()
    dossier.matrice_inter_verts = 'voir page 12 du dossier'
    const res = importDossiersFeux(fichier(dossier), opts)
    const c = res.controllers[res.matches[0].controllerId!]
    expect(c.interGreen).toBeUndefined()
    expect(res.matches[0].avertissements.some((a) => /inter-verts/.test(a) && /rouge intégral par défaut/.test(a)))
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
    const res = importDossiersFeux(fichier(dossier), opts)
    const c = res.controllers[res.matches[0].controllerId!]
    expect(c.plans?.map((p) => [p.name, p.cycle])).toEqual([['PF1', 74]])
    expect(res.matches[0].avertissements.some((a) => /objet et non une liste/.test(a))).toBe(true)
  })

  it('avertit quand « plans_de_feux » est d’une forme illisible', () => {
    const dossier = ve005()
    dossier.plans_de_feux = 'PF1 et PF2'
    dossier.calendrier = null
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.controllers[res.matches[0].controllerId!].plans).toBeUndefined()
    expect(res.matches[0].avertissements.some((a) => /plans_de_feux/.test(a) && /texte/.test(a))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  Escamotage et prolongation                                         */
/* ------------------------------------------------------------------ */

describe('escamotage et prolongation', () => {
  it('n’escamote pas une phase seulement prolongée et signale la contradiction avec le mode cyclique', () => {
    const dossier = ve005()
    ;(dossier.phases as Record<string, unknown>[])[1].prolongation = 'B31, intervalle véhicule 2 s'
    const res = importDossiersFeux(fichier(dossier), opts)
    const c = res.controllers[res.matches[0].controllerId!]
    expect(c.mode).toBe('actuated')
    // Une prolongation de vert n'est pas un escamotage : la phase s'ouvre à chaque cycle.
    expect(c.actuated.skipEmpty).toBe(false)
    expect(c.phases[1].gap).toBe(2)
    expect(res.matches[0].avertissements.some((a) => /cyclique/.test(a) && /adaptatif/.test(a))).toBe(true)
  })

  it('escamote quand une phase est appelée sur détecteur', () => {
    const dossier = ve005()
    ;(dossier.phases as Record<string, unknown>[])[1].appel = ['B21']
    const res = importDossiersFeux(fichier(dossier), opts)
    const c = res.controllers[res.matches[0].controllerId!]
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
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.controllers[res.matches[0].controllerId!].schedule).toBeUndefined()
    expect(res.matches[0].avertissements.some((a) => /PF12/.test(a) && /inconnu/.test(a))).toBe(true)
  })

  it('rattache « PF 1 » à « PF1 » par égalité, sans parler de repli', () => {
    const dossier = ve005()
    dossier.calendrier = { lundi_vendredi: [{ plage: '06:00-09:00', plan: 'PF 1' }] }
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.controllers[res.matches[0].controllerId!].schedule).toEqual([
      { planId: 'pf1', fromMin: 360, toMin: 540, days: [1, 2, 3, 4, 5] },
    ])
    expect(res.matches[0].avertissements.some((a) => /rapprochement/.test(a))).toBe(false)
  })

  it('dit quand un plan n’est rattaché que par rapprochement de libellés', () => {
    const dossier = ve005()
    dossier.calendrier = { lundi_vendredi: [{ plage: '06:00-09:00', plan: 'PF1 bis' }] }
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.controllers[res.matches[0].controllerId!].schedule![0].planId).toBe('pf1')
    expect(res.matches[0].avertissements.some((a) => /rapprochement/.test(a) && /PF1 bis/.test(a))).toBe(true)
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
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.controllers[res.matches[0].controllerId!].schedule).toEqual([
      { planId: 'pf1', fromMin: 420, toMin: 540, days: [1, 2, 3, 4, 5] },
      { planId: 'pf1', fromMin: 990, toMin: 1140, days: [1, 2, 3, 4, 5] },
    ])
  })

  it('signale un type de jour non reconnu porté par la clé du calendrier', () => {
    const dossier = ve005()
    dossier.calendrier = { 'pendant les vacances scolaires': [{ plage: '06:00-09:00', plan: 'PF1' }] }
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.matches[0].avertissements.some((a) => /vacances scolaires/.test(a) && /non reconnu/.test(a)))
      .toBe(true)
  })

  it('écarte une durée négative et un maxi inférieur au mini, en le disant', () => {
    const dossier = ve005()
    const phases = dossier.phases as Record<string, unknown>[]
    phases[0].mini_s = -5
    phases[1].maxi_s = 4
    delete dossier.plans_de_feux
    dossier.calendrier = null
    const res = importDossiersFeux(fichier(dossier), opts)
    const c = res.controllers[res.matches[0].controllerId!]
    expect(c.phases[0].minGreen).toBe(DEFAULT_SIGNAL_TIMING.minGreen)
    expect(c.phases[0].green).toBe(DEFAULT_SIGNAL_TIMING.minGreen)
    // Le maximum est ramené au minimum, jamais en dessous.
    expect(c.phases[1].maxGreen).toBe(10)
    const avertissements = res.matches[0].avertissements
    expect(avertissements.some((a) => /négative/.test(a))).toBe(true)
    expect(avertissements.some((a) => /inférieur au vert minimal/.test(a))).toBe(true)
  })

  it('distingue une phase sans approche d’une phase fermée par les traversées piétonnes', () => {
    const res = importDossiersFeux(fichier({
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
    }), opts)
    const avertissements = res.matches[0].avertissements
    expect(avertissements.some((a) => /Phase B/.test(a) && /aucune approche/.test(a))).toBe(true)
    // Le dossier ne comporte aucun groupe piéton : parler de traversées enverrait sur une fausse piste.
    expect(avertissements.some((a) => /après prise en compte des traversées piétonnes/.test(a))).toBe(false)
  })

  it('cite le libellé du dossier, et non sa forme normalisée, pour une phase propre à un autre plan', () => {
    const dossier = ve005()
    ;(dossier.phases as Record<string, unknown>[]).push({
      nom: 'Phase C', plan: 'PF3', vehicules: ['V3'], mini_s: 5, maxi_s: 10,
    })
    const res = importDossiersFeux(fichier(dossier), opts)
    const message = res.matches[0].avertissements.find((a) => /n'appartient qu'au plan/.test(a))!
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
    const res = importDossiersFeux(fichier(sansDureeDePhase()), { network: reseauEcritureOsm() })
    const match = res.matches[0]
    expect(match.nodeId).not.toBeNull()
    expect(match.avertissements.some((a) => /introuvable dans la liste des phases/.test(a))).toBe(false)
    const c = Object.values(res.controllers)[0]
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
    const res = importDossiersFeux(fichier({
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
    }), opts)
    const c = Object.values(res.controllers)[0]
    const escamotable = c.phases.find((p) => p.name === 'Phase B escamotable')!
    const simple = c.phases.find((p) => p.name === 'Phase B')!
    const plan = c.plans![0]
    expect(plan.phases[escamotable.id].maxGreen).toBe(22)
    // La phase « B », propre à aucun plan, reste ouverte avec ses propres durées : le réglage « B escam »
    // ne doit pas lui être appliqué.
    expect(plan.phases[simple.id].maxGreen).toBe(9)
  })

  it('ne rattache toujours pas « Phase 12 » à « Phase 1 »', () => {
    const res = importDossiersFeux(fichier({
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
    }), opts)
    const avertissements = res.matches[0].avertissements
    expect(avertissements.some((a) => /« Phase 12 »/.test(a) && /introuvable/.test(a))).toBe(true)
    const c = Object.values(res.controllers)[0]
    // La citation « 1 Repos », elle, désigne bien « Phase 1 Repos » : le préfixe retiré des deux côtés suffit.
    expect(c.plans![0].phases[c.phases[0].id].maxGreen).toBe(41)
  })

  it('distingue « Phase A’ escamotable » de « Phase A escamotable » malgré l’apostrophe', () => {
    const res = importDossiersFeux(fichier({
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
    }), opts)
    const c = Object.values(res.controllers)[0]
    expect(c.plans![0].phases[c.phases[0].id].maxGreen).toBe(12)
    expect(c.plans![0].phases[c.phases[1].id].maxGreen).toBe(30)
    // Ces deux noms sont bien distincts : aucun avertissement d'homonymie ne doit être émis.
    expect(res.matches[0].avertissements.some((a) => /indiscernables|le même nom/.test(a))).toBe(false)
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
    const res = importDossiersFeux(fichier(deuxPlansComposes(['STR1 - PF1', 'STR2 - PF2'])), opts)
    const c = Object.values(res.controllers)[0]
    expect(c.schedule).toHaveLength(2)
    expect(c.schedule![0].planId).toBe(c.plans![0].id)
    expect(c.schedule![1].planId).toBe(c.plans![1].id)
    const avertissements = res.matches[0].avertissements
    expect(avertissements.some((a) => /plan « STR1 - PF1 » inconnu/.test(a))).toBe(false)
    expect(avertissements.some((a) => /« STR1 - PF1 » → « PF1 - STR1 »/.test(a) && /repli|rapprochement/.test(a))).toBe(true)
  })

  it('garde l’égalité stricte silencieuse', () => {
    const res = importDossiersFeux(fichier(deuxPlansComposes(['PF1 - STR1', 'PF2 - STR2'])), opts)
    expect(res.matches[0].avertissements.some((a) => /rapprochement de libellés/.test(a))).toBe(false)
  })

  it('refuse de trancher entre deux plans qui portent les mêmes mots', () => {
    // Deux plans du même jeu de mots ne se départagent pas : rattacher l'un des deux au hasard donnerait
    // au carrefour un cycle et des verts qui ne sont pas les siens, sans que rien ne le signale.
    const dossier = deuxPlansComposes(['STR1 - HPM - PF1', 'PF2 - STR2'])
    const plans = dossier.plans_de_feux as Record<string, unknown>[]
    plans[0].nom = 'PF1 - STR1 - HPM'
    plans[1].nom = 'HPM - PF1 - STR1'
    const res = importDossiersFeux(fichier(dossier), opts)
    expect(res.matches[0].avertissements.some((a) => /plan « STR1 - HPM - PF1 » inconnu/.test(a))).toBe(true)
  })
})

describe('colonne « jaune » donnée par catégorie de groupes', () => {
  function avecJaune(jaune: unknown): Record<string, unknown> {
    const dossier = ve005()
    ;(dossier.matrice_inter_verts as Record<string, unknown>).valeur_jaune_s = jaune
    return dossier
  }

  it('applique une valeur de catégorie à tous les groupes véhicules', () => {
    const res = importDossiersFeux(fichier(avecJaune({ vehicules: 3 })), opts)
    const c = Object.values(res.controllers)[0]
    // V1 et V3 sont les seuls groupes véhicules ; P2 et P4 n'ont pas de jaune.
    expect(c.amberByGroup).toEqual({ V1: 3, V3: 3 })
    expect(c.amber).toBe(3)
    expect(res.matches[0].avertissements.some((a) => /« vehicules »/.test(a) && /catégorie/.test(a))).toBe(true)
  })

  it('accepte « VL », « voitures » et un nombre seul', () => {
    for (const jaune of [{ VL: 4 }, { voitures: 4 }, 4]) {
      const res = importDossiersFeux(fichier(avecJaune(jaune)), opts)
      expect(Object.values(res.controllers)[0].amberByGroup).toEqual({ V1: 4, V3: 4 })
    }
  })

  it('laisse la valeur nommée d’un groupe l’emporter sur celle de la catégorie', () => {
    const res = importDossiersFeux(fichier(avecJaune({ vehicules: 3, V3: 5 })), opts)
    expect(Object.values(res.controllers)[0].amberByGroup).toEqual({ V1: 3, V3: 5 })
  })

  it('écarte une clé qui n’est ni un groupe ni une catégorie, et le dit', () => {
    const res = importDossiersFeux(fichier(avecJaune({ V1: 3, V9: 3 })), opts)
    expect(Object.values(res.controllers)[0].amberByGroup).toEqual({ V1: 3 })
    expect(res.matches[0].avertissements.some((a) => /« V9 »/.test(a) && /sans correspondance/.test(a))).toBe(true)
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

  it('rattache un carrefour que ces seuls écarts d’écriture faisaient manquer', () => {
    const res = importDossiersFeux(fichier({
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
    }), { network: reseauEcritureOsm() })
    const match = res.matches[0]
    expect(match.confiance).toBe('sure')
    expect(match.nodeId).toBe('c')
    // Le carrefour voisin porte la « Croix des Pères » : il ne doit pas entrer en concurrence.
    expect(match.raison).toContain('Rue du Dr Igor Masourenok')
    expect(match.groupesNonRattaches).toEqual([])
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
    const res = importDossiersFeux(
      fichier(dossierRD(['Avenue du Général de Gaulle (D1082)', 'Rue de la Croix Borne'])),
      { network: reseauEcritureOsm() },
    )
    const match = res.matches[0]
    expect(match.nodeId).toBe('c')
    expect(match.groupesNonRattaches).toEqual([])
    expect(match.avertissements.some((a) => /« RD 1082 » → « Avenue du Général de Gaulle »/.test(a))).toBe(true)
  })

  it('laisse le groupe non rattaché et nomme la cause exacte quand rien ne nomme la référence', () => {
    const res = importDossiersFeux(
      fichier(dossierRD(['RD 1082', 'Rue de la Croix Borne'])),
      { network: reseauEcritureOsm() },
    )
    const match = res.matches[0]
    expect(match.nodeId).toBe('c')
    expect(match.groupesNonRattaches).toContain('V1')
    const cause = match.avertissements.find((a) => /référence routière/.test(a))!
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
  const res = importDossiersFeux(fichier(ve004AvecTraversee()), opts)
  const m = res.matches[0]
  const c = res.controllers[m.controllerId!]
  const phaseB = c.phases[1]

  it('garde ces mouvements au vert et n’annonce plus une phase sans vert', () => {
    expect(phaseB.groups).toEqual(['V2', 'P3'])
    expect(Object.keys(phaseB.movements).sort()).toEqual(['eBonnet_cPagnol>cPagnol_nPagnol', 'eBonnet_cPagnol>cPagnol_sPagnol'])
    // Ce que simule le moteur : deux verts permis, aucun rouge. L'ancien message parlait d'une phase sans
    // aucun mouvement au vert, ce qui envoyait l'exploitant chercher un défaut inexistant.
    expect(Object.values(phaseMovements(c, phaseB)).sort()).toEqual(['permitted', 'permitted'])
    expect(m.avertissements.some((a) => /aucun mouvement au vert/.test(a))).toBe(false)
  })

  it('avertit que la phase n’ouvre aucun vert protégé et que sa capacité est optimiste', () => {
    const a = m.avertissements.find((x) => x.startsWith('Phase « Phase B escamotable »'))!
    expect(a).toMatch(/tous franchis par une traversée piétonne verte/)
    // La traversée en cause est nommée : c'est par elle que l'exploitant remonte au dossier.
    expect(a).toContain('P3')
    expect(a).toMatch(/aucun vert protégé/)
    expect(a).toMatch(/optimiste/)
    // P3 est sur bouton poussoir : la cession ne vaut que les cycles où la traversée est appelée.
    expect(a).toMatch(/bouton poussoir \(P3\)/)
    // La phase A, elle, n'a pas de traversée concomitante : rien ne doit être dit à son sujet.
    expect(m.avertissements.some((x) => x.startsWith('Phase « Phase A Repos »'))).toBe(false)
  })

  it('ne parle de bouton poussoir que pour une traversée qui n’est pas en rappel', () => {
    const dossier = ve004AvecTraversee()
    ;(dossier.phases as Record<string, unknown>[])[1].pietons_en_rappel = true
    const autre = importDossiersFeux(fichier(dossier), opts)
    const a = autre.matches[0].avertissements.find((x) => x.startsWith('Phase « Phase B escamotable »'))!
    expect(a).toMatch(/tous franchis par une traversée piétonne verte/)
    expect(a).not.toMatch(/bouton poussoir/)
  })

  it('ne nomme que les traversées qui franchissent réellement un mouvement ouvert', () => {
    const dossier = ve004AvecTraversee()
    // P5 traverse une voie absente de ce carrefour : elle ne franchit aucun mouvement, la citer
    // enverrait l'exploitant vérifier une traversée qui n'y est pour rien.
    ;(dossier.groupes as unknown[]).push({ id: 'P5', type: 'pieton', voie: 'Traversée Rue du Stade' })
    ;(dossier.phases as Record<string, unknown>[])[1].pietons = ['P3', 'P5']
    const autre = importDossiersFeux(fichier(dossier), opts)
    const a = autre.matches[0].avertissements.find((x) => x.startsWith('Phase « Phase B escamotable »'))!
    expect(a).toContain('P3')
    expect(a).not.toContain('P5')
  })
})
