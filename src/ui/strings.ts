/**
 * Toutes les chaînes visibles de l'interface (français), le formatage des nombres (`fr-FR`)
 * et les utilitaires d'export de fichiers (nom, cellule CSV, téléchargement).
 *
 * Les panneaux n'écrivent aucune chaîne littérale destinée à l'utilisateur : ils lisent `S`.
 * Les libellés dérivés du modèle (classes de voie, régulations, modes de feux…) passent par les
 * dictionnaires exhaustifs de ce fichier, ce qui garantit qu'aucune valeur du modèle n'apparaît brute.
 */
import type { ControlType, GreenKind, HighwayClass, SignalMode } from '@/model/types'
import type { ColorMode, SidebarTab } from '@/state/storeTypes'
import type { TurnType } from '@/model/geometry'

/* ------------------------------------------------------------------ */
/*  Formatage                                                          */
/* ------------------------------------------------------------------ */

const formatters = new Map<number, Intl.NumberFormat>()

function formatter(digits: number): Intl.NumberFormat {
  let f = formatters.get(digits)
  if (!f) {
    f = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    formatters.set(digits, f)
  }
  return f
}

/** Nombre au format français ; « — » si la valeur n'est pas finie. */
export function formatNumber(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—'
  // -0 est affiché comme 0 (les écarts nuls ne doivent pas porter de signe).
  return formatter(digits).format(value === 0 ? 0 : value)
}

/** Nombre signé (« +12,3 ») pour les écarts. */
export function formatSigned(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—'
  const text = formatNumber(Math.abs(value), digits)
  if (Math.abs(value) < 0.5 / 10 ** digits) return text
  return `${value > 0 ? '+' : '−'}${text}`
}

/** Part (0..1) affichée en pourcentage. */
export function formatPercent(share: number, digits = 0): string {
  if (!Number.isFinite(share)) return '—'
  return `${formatNumber(share * 100, digits)} %`
}

/** Multiplicateur de vitesse de la simulation (« ×12 »). */
export function formatSpeed(multiplier: number): string {
  return `×${formatNumber(multiplier)}`
}

/** Durée en `mm:ss` (les minutes ne sont pas bornées à 60). */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Durée lisible : « 45 s », « 12 min », « 1 h 05 ». */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const total = Math.round(seconds)
  if (total < 60) return `${formatNumber(total)} s`
  const minutes = Math.round(total / 60)
  if (minutes < 60) return `${formatNumber(minutes)} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

/** Heure du jour (minutes depuis minuit) : « 8 h 05 ». Une valeur hors de la journée est ramenée dans 0–24 h. */
export function formatTimeOfDay(minOfDay: number): string {
  if (!Number.isFinite(minOfDay)) return '—'
  const total = ((Math.round(minOfDay) % 1440) + 1440) % 1440
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')}`
}

/** Date et heure locales (bibliothèque, référence figée). */
export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

/** Fragment de nom de fichier : minuscules sans accent ni ponctuation. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'projet'
}

/** Nom du fichier exporté : `circulation-<slug>-<AAAA-MM-JJ>.<ext>`. */
export function exportFileName(name: string, extension: string): string {
  return `circulation-${slugify(name)}-${new Date().toISOString().slice(0, 10)}.${extension}`
}

/** Échappement d'une cellule CSV (séparateur `;`, décimales françaises). */
export function csvCell(value: string | number, digits = 2): string {
  if (typeof value === 'number') return Number.isFinite(value) ? formatNumber(value, digits) : ''
  return /[;"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Propose au navigateur le téléchargement d'un contenu texte (export JSON ou CSV). */
export function downloadText(fileName: string, mimeType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Laisse le temps au navigateur d'ouvrir le flux avant de libérer l'URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/* ------------------------------------------------------------------ */
/*  Dictionnaires dérivés du modèle                                    */
/* ------------------------------------------------------------------ */

export const TAB_LABELS: Record<SidebarTab, string> = {
  ville: 'Ville',
  reseau: 'Réseau',
  feux: 'Feux',
  trafic: 'Trafic',
  resultats: 'Résultats',
  comparer: 'Comparer',
}

export const HIGHWAY_LABELS: Record<HighwayClass, string> = {
  motorway: 'Autoroute',
  trunk: 'Voie rapide',
  primary: 'Route principale',
  secondary: 'Route secondaire',
  tertiary: 'Route locale',
  unclassified: 'Voie non classée',
  residential: 'Rue résidentielle',
  living_street: 'Zone de rencontre',
  motorway_link: "Bretelle d'autoroute",
  trunk_link: 'Bretelle de voie rapide',
  primary_link: 'Bretelle principale',
  secondary_link: 'Bretelle secondaire',
  tertiary_link: 'Bretelle locale',
}

export const CONTROL_LABELS: Record<ControlType, string> = {
  signals: 'Feux tricolores',
  stop: 'Stop',
  give_way: 'Cédez-le-passage',
  priority_right: 'Priorité à droite',
  priority_class: 'Priorité à la voie principale',
  roundabout: 'Giratoire',
}

export const SIGNAL_MODE_LABELS: Record<SignalMode, string> = {
  fixed: 'Plan fixe',
  actuated: 'Adaptatif (détecteurs)',
  flashing: 'Clignotant',
  off: 'Éteint',
}

/** Jours de la semaine du modèle (`SimSettings.dayOfWeek`, 1 = lundi à 7 = dimanche). */
export const DAY_LABELS: Record<number, string> = {
  1: 'Lundi',
  2: 'Mardi',
  3: 'Mercredi',
  4: 'Jeudi',
  5: 'Vendredi',
  6: 'Samedi',
  7: 'Dimanche',
}

export const GREEN_KIND_LABELS: Record<GreenKind, string> = {
  protected: 'Protégé',
  permitted: 'Permis (cède le passage)',
}

export const TURN_LABELS: Record<TurnType, string> = {
  through: 'Tout droit',
  left: 'À gauche',
  right: 'À droite',
  uturn: 'Demi-tour',
}

export const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  class: 'Classe de voie',
  flow: 'Débit',
  delay: 'Retard',
  saturation: 'Saturation',
  speed: 'Vitesse moyenne',
  queue: 'File d’attente',
  deltaDelay: 'Écart de retard',
  deltaFlow: 'Écart de débit',
}

/** Couleurs des séries (palette catégorielle validée, mode clair). */
export const SERIES_COLORS = {
  principal: '#2a78d6',
  secondaire: '#eb6834',
  tertiaire: '#1baf7a',
} as const

/* ------------------------------------------------------------------ */
/*  Textes de l'interface                                              */
/* ------------------------------------------------------------------ */

export const S = {
  app: {
    titre: 'Circulation',
    projetSansNom: 'Projet sans nom',
    nomProjet: 'Nom du projet',
    annuler: 'Annuler',
    retablir: 'Rétablir',
    enregistrer: 'Enregistrer dans la bibliothèque',
    enregistre: 'Enregistré',
    modifications: 'Modifications non enregistrées',
    importer: 'Importer un projet JSON',
    exporter: 'Exporter en JSON',
    aucunProjet: 'Aucun projet chargé. Ouvrez l’onglet Ville pour charger une commune ou une démonstration.',
    erreur: 'Erreur',
    annulerChargement: 'Annuler le chargement',
    fermer: 'Fermer',
    chargement: 'Chargement…',
    onglets: 'Onglets de l’interface',
  },
  sim: {
    demarrer: 'Démarrer la simulation',
    pause: 'Mettre en pause',
    reinitialiser: 'Réinitialiser la simulation',
    rapide: 'Calcul rapide',
    rapideEnCours: 'Calcul rapide en cours…',
    vitesse: 'Vitesse',
    horloge: 'Temps simulé',
    chauffe: 'chauffe',
    enCirculation: 'En circulation',
    entres: 'Entrés',
    sortis: 'Sortis',
    attente: 'En attente aux entrées',
    pasParSeconde: 'pas/s',
    pasAPas: 'Pas à pas',
    pasAPasAide: 'Avance la simulation d’une minute simulée.',
    progression: 'Progression',
    perime: 'Le réseau a changé : la simulation repartira de zéro.',
    statut: { idle: 'À l’arrêt', running: 'En cours', paused: 'En pause', done: 'Terminée' },
  },
  carte: {
    fond: 'Fond de carte',
    vehicules: 'Véhicules',
    etiquettes: 'Étiquettes',
    couleur: 'Couleur des tronçons',
    legende: 'Légende',
    aucuneDonnee: 'Lancez une simulation pour colorer le réseau selon cet indicateur.',
    outilOndeVerteActif: 'Onde verte : cliquez le carrefour de départ puis celui d’arrivée (Échap pour annuler)',
    outilAjoutTronconActif: 'Ajout de tronçon : cliquez deux nœuds (Échap pour annuler)',
  },
  ville: {
    titre: 'Commune',
    recherche: 'Rechercher une commune (nom ou code postal)',
    recherchePlaceholder: 'Veauche, Saint-Étienne, 42340…',
    codePostalIncomplet: 'Saisissez les 5 chiffres du code postal.',
    rechercheEnCours: 'Recherche…',
    aucunResultat: 'Aucune commune ne correspond à cette recherche.',
    habitants: 'habitants',
    charger: 'Charger',
    rechargerOsm: 'Retélécharger depuis OpenStreetMap',
    rechargerAide: 'Ignore le cache local et reprend les données OpenStreetMap à jour.',
    demos: 'Démonstrations embarquées',
    demoAide: 'Extraits prêts à l’emploi, utilisables hors ligne.',
    bibliotheque: 'Bibliothèque',
    bibliothequeVide: 'Aucun projet enregistré pour l’instant.',
    supprimer: 'Supprimer',
    confirmerSuppression: 'Supprimer définitivement ce projet de la bibliothèque ?',
    troncons: 'tronçons',
    reseau: 'Réseau chargé',
    statsWays: 'Chemins OSM lus',
    statsEdges: 'Tronçons',
    statsNodes: 'Nœuds',
    statsEntries: 'Entrées',
    statsExits: 'Sorties',
    statsSignals: 'Nœuds à feux',
    statsControllers: 'Contrôleurs de feux',
    statsStops: 'Stops',
    statsGiveWays: 'Cédez-le-passage',
    statsRestrictions: 'Interdictions de tourner',
    statsDropped: 'Tronçons écartés',
    avertissements: 'Avertissements d’import',
    avertissementsAucun: 'Aucun avertissement.',
    attribution: 'Données',
    aucunReseau: 'Chargez une commune pour construire le réseau.',
  },
  reseau: {
    titre: 'Réseau',
    aucuneSelection: 'Cliquez sur un tronçon ou un nœud de la carte pour l’examiner et le modifier.',
    aideEdition: 'Glissez un nœud pour le déplacer, déposez-le sur un autre pour fusionner les deux. La touche Suppr efface la sélection.',
    outils: 'Outils',
    outilSelection: 'Sélection',
    outilOnde: 'Onde verte',
    outilAjout: 'Ajouter un tronçon',
    outilOndeAide: 'Cliquez deux nœuds : les décalages des feux du trajet sont recalculés.',
    outilAjoutAide: 'Cliquez deux nœuds pour créer un tronçon entre eux.',
    outilPremierNoeud: 'Premier nœud choisi : cliquez le second.',
    doubleSens: 'Double sens',
    noeud: 'Nœud',
    troncon: 'Tronçon',
    sansNom: 'Voie sans nom',
    noeudSansNom: 'Carrefour sans nom',
    label: 'Nom du carrefour',
    regulation: 'Régulation',
    regulationImplicite: 'Régulation implicite (déduite du réseau)',
    miniGiratoire: 'Mini-giratoire',
    approchesCedent: 'Approches qui marquent l’arrêt / cèdent le passage',
    approchesToutes: 'Aucune approche cochée : toutes cèdent le passage.',
    interdictions: 'Mouvements autorisés (approche → sortie)',
    interdictionsAide: 'Décochez une case pour interdire ce mouvement.',
    aucunMouvement: 'Ce nœud n’a aucun mouvement (nœud frontière ou impasse).',
    versFeux: 'Ouvrir le plan de feux',
    supprimerNoeud: 'Supprimer le nœud',
    supprimerTroncon: 'Supprimer le tronçon',
    nom: 'Nom de la voie',
    classe: 'Classe',
    voies: 'Voies',
    vitesse: 'Vitesse',
    longueur: 'Longueur',
    estimee: 'estimée',
    estimeeAide: 'Valeur déduite de la classe de voie : le tag OpenStreetMap est absent.',
    sens: 'Sens de circulation',
    sensUnique: 'Sens unique',
    inverser: 'Inverser',
    ferme: 'Tronçon fermé à la circulation',
    appliquerInverse: 'Appliquer aussi au sens opposé',
    sensOppose: 'Sens opposé',
    sensOpposeAucun: 'Aucun (sens unique)',
    de: 'De',
    vers: 'Vers',
  },
  feux: {
    titre: 'Feux tricolores',
    aucun: 'Aucun carrefour à feux. Sélectionnez un nœud dans l’onglet Réseau et choisissez « Feux tricolores » pour en créer un.',
    liste: 'Carrefours à feux',
    cycle: 'Cycle',
    noeuds: 'nœuds',
    mode: 'Mode',
    decalage: 'Décalage',
    orange: 'Orange',
    rougeIntegral: 'Rouge intégral',
    sauterPhases: 'Sauter les phases sans demande',
    phases: 'Phases',
    phase: 'Phase',
    nomPhase: 'Nom de la phase',
    vert: 'Vert',
    vertMin: 'Vert min.',
    vertMax: 'Vert max.',
    prolongation: 'Prolongation',
    monter: 'Monter la phase',
    descendre: 'Descendre la phase',
    supprimerPhase: 'Supprimer la phase',
    ajouterPhase: 'Ajouter une phase',
    regenerer: 'Régénérer le plan par défaut',
    confirmerRegenerer: 'Remplacer les phases actuelles par le plan par défaut à deux phases ?',
    schema: 'Cliquez une flèche : rouge → protégé → permis',
    schemaGroupes: 'Verts déduits des groupes du dossier : le schéma n’est pas modifiable ici.',
    rouge: 'Rouge',
    diagramme: 'Déroulement du cycle',
    aucunePhase: 'Aucune phase : tous les mouvements restent au rouge.',
    anomalies: 'Anomalies',
    aucuneAnomalie: 'Plan cohérent : aucun mouvement oublié, aucun conflit protégé.',
    phaseCourante: 'Phase en cours',
    mouvementsAucun: 'Aucun mouvement piloté : vérifiez la géométrie du carrefour.',
    selectionner: 'Voir sur la carte',
    /* --- Dossiers de carrefour (docs/ARCHITECTURE.md §14) --- */
    dossiers: 'Dossiers de carrefour',
    dossiersAide: 'Fichier JSON des dossiers de la commune : groupes de signaux, phases, plans horaires et inter-verts. Les carrefours reconnus remplacent leur plan actuel.',
    dossiersImporter: 'Importer des dossiers',
    dossiersBilan: 'Bilan de l’import',
    dossiersRattaches: 'carrefour(s) rattaché(s) et repris du dossier',
    dossiersNonRattaches: 'dossier(s) laissé(s) de côté, faute de carrefour reconnu',
    dossiersAucun: 'Aucun dossier n’a pu être rattaché : rien n’a été modifié.',
    dossiersReserves: 'Réserves et anomalies',
    /* --- Rattachement à la main d'un dossier laissé de côté (§14.3) --- */
    dossiersARattacher: 'Dossiers à rattacher à la main',
    dossiersARattacherAide: 'Ces dossiers n’ont pas été appliqués : le plan de la commune et celui du fond de carte ne découpent pas les carrefours de la même façon, plusieurs carrefours portent donc les mêmes rues, ou aucun ne les porte. À vous de désigner le bon.',
    dossierVoies: 'Voies du dossier',
    dossierPourquoi: 'Ce qui bloque',
    dossierCandidats: 'Carrefour à retenir',
    dossierCandidatsAide: 'Cliquez un carrefour pour le voir sur la carte ; le survol le met en évidence. Si aucun ne convient, sélectionnez-le sur la carte.',
    dossierAucunCandidat: 'Aucun carrefour ne porte ces voies : sélectionnez-le sur la carte, il apparaîtra ci-dessous.',
    dossierSurCarte: 'sélectionné sur la carte',
    dossierSurCarteAucun: 'Aucun carrefour sélectionné sur la carte',
    dossierVoir: 'voir sur la carte',
    dossierRattacher: 'Appliquer ce dossier au carrefour retenu',
    detacherDossier: 'Détacher le dossier',
    confirmerDetacher: 'Détacher le dossier de ce carrefour ? Ses groupes de signaux, ses plans horaires, son calendrier et ses inter-verts seront remplacés par le plan par défaut à deux phases.',
    origine: 'Origine des réglages',
    groupes: 'Groupes de signaux',
    groupeVehicule: 'Véhicules',
    groupePieton: 'Piétons',
    groupeSansVoie: 'Voie non précisée',
    groupeMouvements: 'mouvement(s)',
    groupeAucunMouvement: 'aucun mouvement',
    groupeRappel: 'Rappel',
    groupeRappelAide: 'Vert piéton donné à chaque cycle, sans appui sur un bouton poussoir.',
    groupePietonAide: 'Un vert piéton interdit les mouvements véhicules qui franchissent sa traversée.',
    plans: 'Plans de feux',
    planCalendrier: 'Suivre le calendrier horaire',
    planCalendrierAide: 'Le contrôleur change de plan en fin de cycle, selon l’heure simulée.',
    planImpose: 'Plan imposé : l’affichage et la simulation ignorent le calendrier horaire.',
    planSelection: 'Plan retenu',
    planActif: 'Plan actif à',
    planUnique: 'Plan unique',
    planDurees: 'Durées de vert fixées par le plan',
    planDecalage: 'Décalage imposé par le plan de feux retenu.',
    planPeriodeInconnue: 'sans période',
    heureSimulee: 'Heure de départ',
    heureSimuleeAide: 'Heure du jour à l’instant 0 : elle désigne le plan de feux actif de chaque carrefour.',
    jourSimule: 'Jour',
    intervertsTitre: 'Inter-verts (s)',
    intervertsAide: 'Temps de sécurité entre le groupe qui perd le vert (en ligne) et celui qui le prend (en colonne). Une case vide signale deux groupes compatibles, qui peuvent être verts ensemble.',
    intervertJaune: 'Jaune',
    intervertsRemplacent: 'Elle remplace l’orange et le rouge intégral ci-dessus pour les phases écrites en groupes.',
  },
  trafic: {
    titre: 'Trafic',
    intensite: 'Intensité globale',
    intensiteAide: 'Multiplie tous les débits d’entrée et le trafic interne.',
    graine: 'Graine aléatoire',
    nouvelleGraine: 'Nouvelle graine',
    graineAide: 'À demande et graine identiques, deux exécutions donnent exactement les mêmes véhicules.',
    entrees: 'Entrées',
    sorties: 'Sorties',
    entree: 'Entrée',
    sortie: 'Sortie',
    debit: 'Débit (véh/h)',
    poids: 'Poids',
    activee: 'Activée',
    total: 'Total',
    aucuneEntree: 'Aucune entrée : le réseau n’a pas de nœud frontière.',
    destination: 'Choix des destinations',
    modeWeights: 'Poids des sorties',
    modeOd: 'Matrice origine-destination',
    matrice: 'Matrice origine-destination (parts en %)',
    matriceAide: 'Chaque ligne est normalisée ; une ligne vide se replie sur les poids de sortie.',
    matriceTropGrande: 'Matrice trop grande pour l’affichage ({n} cellules) : utilisez l’import CSV.',
    effacerMatrice: 'Effacer la matrice',
    interne: 'Trafic interne',
    interneActive: 'Générer du trafic interne à la commune',
    interneDebit: 'Véhicules générés',
    interneVersInterne: 'Trajets internes → destination interne',
    entreeVersInterne: 'Trafic entrant → destination interne',
    csv: 'Import / export CSV',
    csvImporter: 'Importer un CSV',
    csvExporter: 'Exporter en CSV',
    csvAide: 'Formats acceptés : « entrée;débit » ou « entrée;sortie;part ». Séparateur « ; » ou « , ».',
    csvDernier: 'Dernier import',
    csvBilan: 'Bilan de l’import',
    csvEntrees: 'entrées mises à jour',
    csvSorties: 'sorties mises à jour',
    csvCellules: 'cellules origine-destination',
    csvInconnus: 'Identifiants inconnus ignorés',
    reglages: 'Réglages de simulation',
    duree: 'Durée simulée',
    chauffe: 'Chauffe',
    chauffeAide: 'Période initiale exclue des statistiques, le temps que le réseau se remplisse.',
    routageDynamique: 'Routage dynamique (itinéraires recalculés sur les temps mesurés)',
    routageIntervalle: 'Intervalle de recalcul',
    intervalleStats: 'Intervalle des séries',
    avances: 'Paramètres avancés',
    debitSaturation: 'Débit de saturation',
    longueurVehicule: 'Longueur d’un véhicule',
    tempsPerdu: 'Temps perdu au démarrage',
    orangeUtile: 'Orange encore franchissable',
    creneaux: 'Créneaux critiques',
    creneauStop: 'Stop',
    creneauCedez: 'Cédez-le-passage',
    creneauDroite: 'Priorité à droite',
    creneauGiratoire: 'Giratoire',
    creneauTag: 'Tourne-à-gauche permis',
    tempsSuite: 'Temps de suite',
    arretStop: 'Arrêt au stop',
  },
  resultats: {
    titre: 'Résultats',
    aucun: 'Aucun résultat : lancez une simulation depuis la barre supérieure.',
    enCours: 'Résultats partiels : la simulation est en cours.',
    partiels: 'partiels',
    synthese: 'Synthèse du réseau',
    entres: 'Véhicules entrés',
    sortis: 'Véhicules sortis',
    enCirculation: 'Encore en circulation',
    nonInjectes: 'Non injectés',
    retardMoyen: 'Retard moyen',
    retardTotal: 'Retard total',
    tempsParcours: 'Temps de parcours moyen',
    vehKm: 'Véhicules · km',
    troncons: 'Tronçons',
    sorties: 'Sorties',
    carrefours: 'Carrefours',
    serie: 'Évolution dans le temps',
    serieAucune: 'Sélectionnez une ligne pour afficher son évolution.',
    serieCible: 'Élément suivi',
    serieDebit: 'Débit',
    serieRetard: 'Retard',
    serieFile: 'File d’attente',
    exporterCsv: 'Exporter le tableau en CSV',
    couleurCarte: 'Couleur de la carte',
    avertissements: 'Avertissements de simulation',
    col: {
      troncon: 'Tronçon',
      classe: 'Classe',
      debit: 'Débit (véh/h)',
      vitesse: 'Vitesse (km/h)',
      retard: 'Retard (s)',
      retardTotalTroncon: 'Retard cumulé',
      saturation: 'Saturation',
      fileMax: 'File max.',
      fileMoy: 'File moy.',
      entres: 'Entrés',
      sortis: 'Sortis',
      sortie: 'Sortie',
      vehicules: 'Véhicules',
      tempsParcours: 'Parcours (s)',
      carrefour: 'Carrefour',
      approches: 'Approches',
      regulation: 'Régulation',
      retardMax: 'Retard max. (s)',
      fileMaxCarrefour: 'File max.',
    },
    lignesAffichees: '{n} lignes affichées sur {total}',
    reseauEntier: 'Ensemble du réseau',
  },
  comparer: {
    titre: 'Comparer',
    aucuneReference: 'Aucune référence figée. Figez l’état courant pour comparer vos modifications à cette situation de départ.',
    figer: 'Figer comme référence',
    figerAide: 'Enregistre le réseau, la demande, les réglages et les derniers résultats.',
    effacer: 'Effacer la référence',
    confirmerEffacer: 'Effacer la référence figée ?',
    libelle: 'Nom de la référence',
    figeeLe: 'Figée le',
    sansResultats: 'La référence n’a pas de résultats : lancez une simulation puis figez-la de nouveau.',
    varianteSansResultats: 'Lancez une simulation pour comparer la variante à la référence.',
    reference: 'Référence',
    variante: 'Variante',
    ecart: 'Écart',
    indicateur: 'Indicateur',
    ecartRetard: 'Δ retard (s)',
    ecartDebit: 'Δ débit (véh/h)',
    ecartFileMax: 'Δ file max.',
    ecartVehicules: 'Δ véhicules',
    ecartParcours: 'Δ parcours (s)',
    synthese: 'Synthèse',
    troncons: 'Écarts par tronçon',
    sorties: 'Écarts par sortie',
    carteRetard: 'Carte des écarts de retard',
    carteDebit: 'Carte des écarts de débit',
    memeGraine: 'Référence et variante partagent la graine : les écarts ne viennent que de vos modifications.',
    grainesDifferentes: 'Les graines diffèrent : une part des écarts vient du tirage aléatoire.',
    aucunEcart: 'Aucun écart : les deux exécutions donnent exactement les mêmes valeurs.',
    modifications: 'Modifications depuis la référence',
    aucuneModification: 'Aucune modification enregistrée depuis la référence.',
  },
  unites: {
    s: 's',
    min: 'min',
    km: 'km',
    m: 'm',
    kmh: 'km/h',
    vehH: 'véh/h',
    veh: 'véh',
    vehKm: 'véh·km',
    pourcent: '%',
  },
} as const
