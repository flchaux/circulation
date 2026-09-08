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
import { validateController } from '@/model/signals'
import {
  heureEnMinutes, heuresDuTexte, importDossiersFeux, joursDuLibelle, memeVoie, normaliserVoie,
  plagesDuTexte, typeDeGroupeDeclare,
} from './dossierFeux'

/* ------------------------------------------------------------------ */
/*  Réseau de test : quatre carrefours nommés comme à Veauche          */
/* ------------------------------------------------------------------ */

function reseauDeTest(): Network {
  const nodes: Record<NodeId, NetNode> = {}
  const edges: Record<string, NetEdge> = {}
  const noeud = (id: string, x: number, y: number, boundary = false) => { nodes[id] = { id, x, y, boundary } }
  const branche = (a: string, b: string, nom: string) => {
    const longueur = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y)
    const tronçon = (de: string, vers: string, inverse: string): NetEdge => ({
      id: `${de}_${vers}`,
      from: de,
      to: vers,
      reverseOf: inverse,
      name: nom,
      highway: 'secondary',
      lanes: 1,
      maxspeed: 50,
      length: longueur,
      geometry: [[nodes[de].x, nodes[de].y], [nodes[vers].x, nodes[vers].y]],
      roundabout: false,
      closed: false,
      bannedTo: [],
      estimated: { lanes: false, maxspeed: false },
    })
    edges[`${a}_${b}`] = tronçon(a, b, `${b}_${a}`)
    edges[`${b}_${a}`] = tronçon(b, a, `${a}_${b}`)
  }

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

  return { nodes, edges, controls: {}, controllers: {} }
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
  })

  it('reporte le rappel piéton déclaré par la phase sur le groupe', () => {
    expect(c5.groups!.find((g) => g.id === 'P4')!.recall).toBe(true)
    expect(c5.groups!.find((g) => g.id === 'P2')!.recall).toBeUndefined()
  })

  it('ferme les mouvements que le vert piéton de la phase traverse', () => {
    const phaseA = c5.phases[0]
    expect(phaseA.name).toBe('Phase A Repos')
    expect(phaseA.groups).toEqual(['V1', 'P4'])
    // P4 traverse la Croix de Borne : seuls les mouvements tout droit de la Libération restent verts.
    expect(Object.keys(phaseA.movements).sort()).toEqual(['cJou_cLib>cLib_w', 'w_cLib>cLib_cJou'])
    expect(phaseA.movements['w_cLib>cLib_cJou']).toBe('protected')
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
    // Seul reproche possible ici : les tourne-à-droite et tourne-à-gauche restent fermés tout le cycle,
    // conséquence directe de la règle « un vert piéton interdit les mouvements sécants » (§14.5) appliquée
    // à un carrefour dont les deux traversées sont vertes à chaque cycle. Aucun conflit protégé,
    // aucun mouvement orphelin, aucune durée aberrante ne doit apparaître.
    const anomalies5 = validateController(reseau, c5)
    expect(anomalies5).toHaveLength(1)
    expect(anomalies5[0]).toMatch(/fermé\(s\) par un vert piéton/)
    const anomalies6 = validateController(reseau, c6)
    expect(anomalies6.every((a) => /fermé\(s\) par un vert piéton/.test(a))).toBe(true)
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
    // Pris pour un groupe véhicule, P4 ouvrirait les mouvements de la Croix de Borne au lieu de les fermer.
    expect(Object.keys(c.phases[0].movements).sort()).toEqual(['cJou_cLib>cLib_w', 'w_cLib>cLib_cJou'])
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
