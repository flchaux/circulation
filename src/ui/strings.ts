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

/**
 * Durée d'un trajet : « 45 s », « 2 min 10 s », « 1 h 04 min ».
 *
 * Plus précise que `formatDuration`, qui arrondit à la minute : deux itinéraires concurrents se tiennent
 * souvent en quelques dizaines de secondes, et les afficher tous deux à « 7 min » reviendrait à effacer
 * exactement ce que l'on compare.
 */
export function formatDureeTrajet(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  const reste = total % 60
  if (minutes < 60) return reste ? `${minutes} min ${String(reste).padStart(2, '0')} s` : `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** Heure du jour (minutes depuis minuit) : « 8 h 05 ». Une valeur hors de la journée est ramenée dans 0–24 h. */
export function formatTimeOfDay(minOfDay: number): string {
  if (!Number.isFinite(minOfDay)) return '—'
  const total = ((Math.round(minOfDay) % 1440) + 1440) % 1440
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')}`
}

/** Valeur d'un `<input type="time">` (« 08:30 ») à partir de minutes depuis minuit. */
export function heureInput(minOfDay: number): string {
  const total = Math.max(0, Math.min(1439, Math.round(minOfDay)))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
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
    outilItinerairesActif: 'Itinéraires : cliquez le nœud de départ puis celui d’arrivée (Échap pour annuler)',
    outilPassageActif: 'Point de passage : cliquez le nœud par lequel l’itinéraire doit passer (Échap pour annuler)',
    outilAjoutTronconActif: 'Ajout de tronçon : cliquez deux nœuds (Échap pour annuler)',
    outilPoseNoeudActif: 'Pose d’un nœud : cliquez l’emplacement voulu (Échap pour annuler)',
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
  itineraires: {
    titre: 'Itinéraires les plus courts',
    de: 'De',
    vers: 'vers',
    rang: 'N°',
    temps: 'Temps',
    ecart: 'Écart',
    longueur: 'Longueur',
    aucun: 'Aucun itinéraire ne relie ces deux nœuds : sens uniques, interdictions de tourner ou tronçons fermés les séparent.',
    perime: 'Le réseau a changé depuis le calcul : les itinéraires ne sont plus affichés.',
    recalculer: 'Recalculer',
    effacer: 'Effacer',
    aide: 'Temps à réseau vide, retard des carrefours traversés compris (feux, stops, cédez-le-passage) — le même coût que celui sur lequel le moteur choisit ses itinéraires.',
    survolAide: 'Survolez une ligne pour mettre l’itinéraire en avant sur la carte ; les autres s’estompent.',
    identique: 'Le plus rapide',
    passage: 'Ajouter un itinéraire par un point de passage',
    passageAide: 'Cliquez sur la carte le nœud à traverser : l’itinéraire le plus court qui va du départ à l’arrivée en passant par lui est ajouté à la liste. L’outil reste actif pour en essayer d’autres.',
    passageMarque: '◎',
    passageTitre: 'Itinéraire imposé à traverser {noeud}.',
    passageLigne: 'N° {rang} · par {noeud}',
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
    outilItineraires: 'Itinéraires',
    outilItinerairesAide: 'Cliquez deux nœuds : les cinq itinéraires les plus courts entre eux sont surlignés sur la carte, avec leur temps de parcours.',
    outilAjoutAide: 'Cliquez deux nœuds pour créer un tronçon entre eux.',
    outilNoeud: 'Poser un nœud',
    outilNoeudAide: 'Cliquez l’emplacement voulu sur la carte : un nœud y est posé, puis sélectionné. Il sert à raccorder une voie nouvelle là où OpenStreetMap ne fournit aucun point.',
    outilNoeudAideRaccord: 'Posé seul, il ne change rien : aucun véhicule n’y passe tant qu’aucun tronçon n’y aboutit. Pour le relier, prenez « Ajouter un tronçon » et cliquez ce nœud puis celui à joindre. Il se déplace, se fusionne et se supprime ensuite comme n’importe quel nœud du réseau.',
    outilNoeudSurNoeud: 'Un clic sur un nœud existant le sélectionne au lieu d’en empiler un second au même endroit.',
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
    /* --- Carrefour regroupé : plusieurs nœuds sous un même contrôleur --- */
    regroupement: 'Carrefour regroupé',
    regroupementAide: 'Une armoire commande parfois un carrefour que le fond de carte découpe en deux nœuds voisins (carrefour décalé), ou deux carrefours proches. Regroupés ici, leurs mouvements sont pilotés par ce contrôleur — les tronçons intérieurs au regroupement cessent d’être des branches — et le dossier importé s’applique à l’ensemble.',
    regroupementNoeuds: 'Nœuds de ce contrôleur',
    regroupementRetirer: 'Retirer',
    regroupementRetirerAide: 'Un contrôleur garde au moins un nœud.',
    regroupementAjouter: 'Ajouter au contrôleur',
    regroupementVoisins: 'Nœud voisin à regrouper',
    regroupementAucunVoisin: 'Aucun nœud voisin à regrouper : ce carrefour est seul.',
    regroupementDejaFeux: 'déjà à feux',
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
    schemaGroupesPietons: 'Les mouvements affichés « permis » le sont parce qu’une traversée piétonne de la phase les franchit : ils ont le vert et cèdent aux piétons.',
    rouge: 'Rouge',
    diagramme: 'Déroulement du cycle',
    aucunePhase: 'Aucune phase : tous les mouvements restent au rouge.',
    anomalies: 'Anomalies',
    aucuneAnomalie: 'Plan cohérent : aucun mouvement oublié, aucun conflit protégé.',
    phaseCourante: 'Phase en cours',
    mouvementsAucun: 'Aucun mouvement piloté : vérifiez la géométrie du carrefour.',
    selectionner: 'Voir sur la carte',
    /* --- Dossier de carrefour (docs/ARCHITECTURE.md §14) --- */
    dossier: 'Dossier de carrefour',
    dossierAide: 'Fichier JSON du dossier de CE carrefour, tel que la commune le livre (un fichier par carrefour) : groupes de signaux, phases, plans horaires et inter-verts. Il remplace le plan en place ; l’opération est annulable.',
    dossierImporter: 'Importer le dossier de ce carrefour',
    dossierBilan: 'Bilan de l’import',
    dossierApplique: 'Dossier appliqué :',
    dossierGroupes: 'groupe(s) de feux rattaché(s) aux mouvements du carrefour',
    dossierEchec: 'Le dossier n’a pas été appliqué : le carrefour est inchangé.',
    dossierReserves: 'Réserves et anomalies',
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
    /* §14.5 : une traversée verte en même temps que le groupe véhicule de sa branche déclasse le
       mouvement, elle ne le ferme pas. Le laisser croire mettait huit mouvements de VE001 au rouge. */
    groupePietonAide: 'Un vert piéton ne ferme pas les mouvements véhicules qui franchissent sa traversée : il les fait passer de protégé à permis, le conducteur qui tourne a le vert et cède aux piétons. Ces mouvements ne sont au rouge que pendant un temps piéton protégé, où aucun groupe véhicule de la branche n’est vert.',
    groupePietonReserve: 'Réserve : la capacité d’un mouvement qui ne cède qu’à des piétons est optimiste, les dossiers ne portant aucune demande piétonne.',
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
    heureSimuleeRappel: 'L’heure et le jour simulés se règlent dans l’onglet Trafic : ils valent pour toute la commune, pas pour ce carrefour.',
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
    heureSimulee: 'Heure de départ',
    jourSimule: 'Jour',
    heureSimuleeAide: 'Jour et heure du début de la simulation, pour toute la commune : ils désignent le plan de feux actif de chaque carrefour, et avancent avec le temps simulé.',
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
  recherche: {
    rechercherDans: 'Rechercher dans',
    placeholder: 'Rechercher…',
    vider: 'Effacer la recherche',
    aucune: 'Aucun résultat pour cette recherche.',
    resultats: '{n} sur {total} correspondent à la recherche',
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
