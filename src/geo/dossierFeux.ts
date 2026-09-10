/**
 * Import du « dossier de carrefour » d'un feu tricolore existant (voir docs/ARCHITECTURE.md §14).
 *
 * Un dossier de carrefour est le document d'exploitation d'un carrefour à feux réel : il décrit les groupes
 * de signaux, les phases, les plans horaires et les temps de sécurité. Seule la partie qui gouverne
 * l'écoulement du trafic est reprise ; tout ce qui relève du matériel, du câblage, de l'électricité, des
 * contrôles réglementaires ou des dispositifs pour malvoyants est délibérément ignoré (§14.2) : le reprendre
 * alourdirait le format de projet sans changer un seul résultat de simulation.
 *
 * Un fichier, un carrefour, et **c'est l'exploitant qui désigne le carrefour** : il sélectionne le feu sur
 * la carte, puis choisit le fichier de ce feu. Le module ne cherche donc plus quel carrefour du réseau un
 * dossier décrit — cette reconnaissance par noms de voies rattachait le dossier au voisin du carrefour
 * décrit dès que le plan de la commune et celui du fond de carte ne découpaient pas les carrefours de la
 * même façon, et demandait un arbitrage à l'exploitant dans la majorité des cas. Autant le lui demander
 * d'emblée : il reste seulement à rattacher les GROUPES du dossier aux mouvements de ce carrefour-là.
 *
 * Trois partis pris guident ce module, parce qu'il lit des documents rédigés par des humains, hétérogènes
 * d'un dossier à l'autre :
 *  - il ne lève JAMAIS d'exception : un fichier illisible produit un résultat vide et des avertissements ;
 *  - il ne devine JAMAIS en silence : un groupe qu'aucun mouvement ne porte est signalé, en français ;
 *  - il ne laisse JAMAIS une clé venant du fichier indexer un objet ordinaire : une ligne de matrice nommée
 *    « __proto__ » écrirait sur `Object.prototype`, et cette pollution survivrait à l'import pour toute la
 *    session du navigateur. Les clés externes passent par une `Map` ou par le filtre `cleReservee`.
 */
import type {
  ControllerId, GreenKind, InterGreenMatrix, MovementKey, Network, NodeControl, NodeId,
  PlanPhaseTiming, PlanSchedule, SignalController, SignalGroup, SignalPhase, SignalPlan,
} from '@/model/types'
import { DEFAULT_SIGNAL_TIMING } from '@/model/defaults'
import { type Adjacency, type Movement, buildAdjacency } from '@/model/geometry'
import { controllerMovements, phaseMovements, phaseTransition, planPhaseTiming, planPhases } from '@/model/signals'

/* ------------------------------------------------------------------ */
/*  Contrat                                                            */
/* ------------------------------------------------------------------ */

export interface DossierImportOptions {
  network: Network
  /** Carrefour à feux qui reçoit le dossier. L'exploitant l'a désigné : rien n'est deviné. */
  controllerId: ControllerId
}

export interface DossierImportResult {
  /**
   * Contrôleur reconstruit d'après le dossier, prêt à remplacer celui du carrefour désigné (même
   * identifiant, mêmes nœuds). `null` quand le fichier n'a rien donné : le carrefour reste intact.
   */
  controller: SignalController | null
  /** Identifiant du dossier (VE001, « Place de l'Europe »…), tel que le fichier le porte. */
  dossierId: string
  nom: string
  /** Groupes du dossier rattachés à au moins un mouvement du carrefour. */
  groupesRattaches: number
  /** Groupes qu'aucun mouvement du carrefour ne porte : ils ne commandent rien. */
  groupesNonRattaches: string[]
  /** Réserves de lecture, en français, destinées à l'exploitant. */
  avertissements: string[]
}

/* ------------------------------------------------------------------ */
/*  Lecture tolérante du JSON                                          */
/* ------------------------------------------------------------------ */

type Rec = Record<string, unknown>

function estObjet(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function chaine(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Nombre fini, sinon `null`. Accepte « 40 » et « 40 s » (les dossiers mélangent les deux).
 * Le signe n'est pas jugé ici : c'est `duree()` qui écarte les valeurs hors domaine et le signale.
 */
function nombre(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const m = /-?\d+(?:[.,]\d+)?/.exec(v)
    if (!m) return null
    const n = Number(m[0].replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function tableau(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Liste de chaînes, en acceptant une chaîne seule et des objets porteurs d'un champ `nom`/`voie`. */
function listeDeChaines(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  const out: string[] = []
  for (const item of tableau(v)) {
    if (typeof item === 'string') out.push(item)
    else if (estObjet(item)) {
      const s = chaine(item.nom) || chaine(item.voie) || chaine(item.libelle) || chaine(item.id)
      if (s) out.push(s)
    }
  }
  return out
}

/**
 * Clés qu'un fichier ne peut pas employer comme index d'objet : `objet['__proto__'] = …` écrit sur
 * `Object.prototype` et contamine toute la session, pas seulement le dossier en cours ; `constructor` et
 * `prototype` masquent des membres du langage. Aucun dossier réel ne nomme un groupe ainsi : la clé est
 * écartée et signalée plutôt que subie.
 */
const CLES_RESERVEES = new Set(['__proto__', 'constructor', 'prototype'])

function cleReservee(cle: string): boolean {
  return CLES_RESERVEES.has(cle)
}

/**
 * Valeur d'une case de matrice, en ignorant tout ce qui viendrait du prototype : `matrice['toString']`
 * répond une fonction sur un objet ordinaire, ce qui ferait passer deux groupes pour incompatibles.
 */
function caseDe(matrice: InterGreenMatrix, de: string, vers: string): number | undefined {
  const ligne = Object.prototype.hasOwnProperty.call(matrice, de) ? matrice[de] : undefined
  if (!ligne || !Object.prototype.hasOwnProperty.call(ligne, vers)) return undefined
  return ligne[vers]
}

/** Nom français du type d'une valeur, pour dire à l'exploitant ce que le dossier porte réellement. */
function typeDeValeur(v: unknown): string {
  if (Array.isArray(v)) return 'liste'
  if (v === null) return 'valeur nulle'
  switch (typeof v) {
    case 'string': return 'texte'
    case 'number': return 'nombre'
    case 'boolean': return 'booléen'
    case 'object': return 'objet'
    default: return typeof v
  }
}

/**
 * Durée en secondes lue au dossier. Une durée négative est une faute de saisie : la retenir donnerait un
 * vert négatif, que le simulateur consommerait comme un vert nul sans jamais le dire à l'exploitant.
 */
function duree(v: unknown, quoi: string, avertissements: string[]): number | null {
  const n = nombre(v)
  if (n === null) return null
  if (n < 0) {
    avertissements.push(`${quoi} : durée négative (${n} s) hors domaine, valeur écartée.`)
    return null
  }
  return n
}

/** Vert minimal et maximal d'une phase, débarrassés des valeurs hors domaine (négatives, maxi < mini). */
function bornesDeVert(
  miniBrut: unknown,
  maxiBrut: unknown,
  quoi: string,
  avertissements: string[],
): { mini: number | null; maxi: number | null } {
  const mini = duree(miniBrut, quoi, avertissements)
  let maxi = duree(maxiBrut, quoi, avertissements)
  if (mini !== null && maxi !== null && maxi < mini) {
    // Un maxi inférieur au mini rendrait la marge de prolongation négative : le maxi est ramené au mini.
    avertissements.push(`${quoi} : vert maximal (${maxi} s) inférieur au vert minimal (${mini} s) ; le maximum est ramené au minimum.`)
    maxi = null
  }
  return { mini, maxi }
}

/** Un champ du dossier porte-t-il une information ? Un tableau ou un texte vide ne déclare rien. */
function renseigne(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  if (estObjet(v)) return Object.keys(v).length > 0
  return true
}

/* ------------------------------------------------------------------ */
/*  Normalisation des libellés de voies                                */
/* ------------------------------------------------------------------ */

/**
 * Abréviations courantes des dossiers et des plans, ramenées au mot entier.
 * Une `Map` et non un objet : un mot de voie nommé « constructor » lirait sinon une propriété héritée
 * d'`Object.prototype` et remplacerait le mot par du code.
 */
const ABREVIATIONS = new Map<string, string>(Object.entries({
  av: 'avenue', ave: 'avenue', aven: 'avenue',
  bd: 'boulevard', bld: 'boulevard', blvd: 'boulevard', boul: 'boulevard',
  rte: 'route', rt: 'route',
  r: 'rue',
  ch: 'chemin', chem: 'chemin',
  pl: 'place',
  imp: 'impasse',
  all: 'allee', allee: 'allee',
  sq: 'square',
  crs: 'cours',
  mte: 'montee',
  st: 'saint', ste: 'sainte', sts: 'saints', stes: 'saintes',
  gal: 'general', gnl: 'general', gen: 'general', gral: 'general',
  dr: 'docteur',
  mal: 'marechal',
  pdt: 'president', pst: 'president',
  cdt: 'commandant',
  fg: 'faubourg',
  gd: 'grand', gde: 'grande',
  crf: 'carrefour',
  trav: 'traversee', tp: 'traversee',
}))

/** Mots de type de voie, retirés en tête pour comparer les noms propres entre eux. */
const TYPES_VOIE = new Set([
  'rue', 'ruelle', 'avenue', 'boulevard', 'route', 'chemin', 'place', 'impasse', 'allee', 'allees',
  'square', 'cours', 'quai', 'montee', 'voie', 'esplanade', 'rond', 'point', 'giratoire', 'carrefour',
  'traversee', 'traversees', 'passage', 'pieton', 'pietons', 'pietonne', 'pietonnes', 'sente', 'faubourg',
  'branche', 'axe', 'direction', 'sens',
])

/** Particules et articles, retirés en tête et en queue du noyau. */
const PARTICULES = new Set(['de', 'du', 'des', 'd', 'la', 'le', 'les', 'l', 'a', 'au', 'aux', 'et', 'en', 'sur', 'sous'])

function sansAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * Apostrophes et tirets typographiques ramenés à leur forme droite, AVANT tout autre traitement.
 *
 * Le réseau OSM porte « Place de l’Europe » (apostrophe U+2019) là où le dossier écrit « Place de
 * l'Europe » : deux libellés identiques à l’œil, mais deux suites de caractères différentes. Le
 * découpage général ramène déjà l’un et l’autre à un espace ; l’unification les rend aussi
 * comparables partout où la ponctuation est conservée — c’est le cas des noms de phases, où
 * l’apostrophe distingue « Phase A' escamotable » de « Phase A escamotable ».
 */
function unifierPonctuation(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc\u00b4\u0060]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
}

/** Libellé de voie comparable : forme complète normalisée + noyau (nom propre seul). */
export interface LibelleVoie {
  /** Libellé d'origine, pour les messages destinés à l'exploitant. */
  brut: string
  /** Forme normalisée complète (« avenue de la liberation »). */
  plein: string
  /** Nom propre seul (« liberation »), type de voie et articles retirés. */
  noyau: string
}

/**
 * Normalise un libellé : accents, casse, ponctuation, abréviations, numéros de route départementale.
 * « Av. Gal de Gaulle » et « Avenue du Général de Gaulle » se ramènent au même noyau « general de gaulle ».
 */
export function normaliserVoie(brut: string): LibelleVoie | null {
  const base = sansAccents(unifierPonctuation(brut).toLowerCase())
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (!base) return null
  // Routes numérotées : « RD 1082 », « route departementale 1082 » et « D1082 » sont la même voie.
  const numerotee = base
    .replace(/\b(?:rd|route departementale|departementale)\s*(\d+)\b/g, 'd$1')
    .replace(/\b(?:rn|route nationale|nationale)\s*(\d+)\b/g, 'n$1')
    // « D 54 » et « M 10 » : sans recoller la lettre au numéro, « d » serait pris pour la particule « de »
    // et le noyau se réduirait au nombre seul, qui ne désigne plus rien.
    .replace(/\b([dnm])\s+(\d+)\b/g, '$1$2')
  const mots = numerotee.split(' ').filter(Boolean).map((m) => ABREVIATIONS.get(m) ?? m)
  if (!mots.length) return null
  const plein = mots.join(' ')
  let debut = 0
  while (debut < mots.length - 1 && (TYPES_VOIE.has(mots[debut]) || PARTICULES.has(mots[debut]))) debut++
  let fin = mots.length
  while (fin > debut + 1 && PARTICULES.has(mots[fin - 1])) fin--
  const noyau = mots.slice(debut, fin).join(' ')
  return { brut: brut.trim(), plein, noyau: noyau || plein }
}

/**
 * Découpe un libellé composé (« Av. de Gaulle / Croix des Pères », « Libération (RD 1082) ») en voies.
 *
 * Un libellé de traversée piétonne y désigne la rue qu'elle franchit, et non une rue de plus :
 * « Traversée », « Piéton », « TP » et « branche » sont des mots de type de voie (`TYPES_VOIE`), que
 * `normaliserVoie` retire du noyau au même titre que « Rue » ou « Avenue ». « Traversée de la branche
 * Villemagne » et « Rue Barthélémy Villemagne » se comparent donc déjà sur « villemagne » contre
 * « barthelemy villemagne » ; c'est le dédoublonnage, ici et sur les rues du carrefour, qui les ramène à
 * une seule et même voie.
 */
export function libellesDeVoies(brut: unknown): LibelleVoie[] {
  const out: LibelleVoie[] = []
  for (const texte of listeDeChaines(brut)) {
    for (const part of texte.split(/[/,;()–—]|\bx\b/i)) {
      const v = normaliserVoie(part)
      // Un fragment de deux caractères ne discrimine rien : il ferait autant de faux rattachements.
      if (v && v.noyau.length >= 3) out.push(v)
    }
  }
  return out
}

function contientMots(botte: string, aiguille: string): boolean {
  return ` ${botte} `.includes(` ${aiguille} `)
}

/**
 * Mots outils, écrits ou non selon la source : le dossier dit « Rue de la Croix de Borne » quand OSM dit
 * « Rue de la Croix Borne ». Ils ne portent aucun sens propre et ne peuvent donc pas distinguer deux
 * voies ; les particules de lieu (« sur », « sous », « en »…) en sont volontairement exclues, elles
 * distinguent de vraies voies (« Rue sur le Pont »).
 */
const MOTS_OUTILS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'd', 'l'])

/** Mots porteurs de sens d'un noyau, les mots outils retirés. */
function motsSignifiants(noyau: string): string[] {
  return noyau.split(' ').filter((m) => m !== '' && !MOTS_OUTILS.has(m))
}

/**
 * `long` est-il `court` avec un seul mot inséré au milieu ?
 *
 * Un dossier écrit « Rue du Dr Igor Masourenok » quand OSM écrit « Rue du Docteur Masourenok » : le
 * prénom est en trop d'un côté. L'insertion reste encadrée, faute de quoi la tolérance rapprocherait des
 * voies réellement différentes : au moins deux mots communs, et le mot en trop ni en tête ni en queue.
 * « Croix des Pères » et « Croix de Borne » gardent ainsi deux mots signifiants distincts.
 */
function unMotEnTrop(court: string[], long: string[]): boolean {
  if (long.length !== court.length + 1 || court.length < 2) return false
  let i = 0
  while (i < court.length && court[i] === long[i]) i++
  // `i` est la position du mot inséré : il doit rester un mot commun de chaque côté.
  if (i === 0 || i >= long.length - 1) return false
  for (let j = i; j < court.length; j++) if (court[j] !== long[j + 1]) return false
  return true
}

/** Deux libellés désignent-ils la même voie ? Égalité du noyau, ou inclusion d'un noyau assez long. */
export function memeVoie(a: LibelleVoie, b: LibelleVoie): boolean {
  if (a.plein === b.plein || a.noyau === b.noyau) return true
  const ma = motsSignifiants(a.noyau)
  const mb = motsSignifiants(b.noyau)
  // Mêmes mots porteurs de sens, dans le même ordre : seuls des mots outils les séparent.
  if (ma.length > 0 && ma.length === mb.length && ma.every((m, i) => m === mb[i])) return true
  if (unMotEnTrop(ma, mb) || unMotEnTrop(mb, ma)) return true
  if (a.noyau.length >= 5 && contientMots(b.noyau, a.noyau)) return true
  if (b.noyau.length >= 5 && contientMots(a.noyau, b.noyau)) return true
  return false
}

/** Une référence routière seule : « RD 1082 », « D1082 », « D 54 » se normalisent en « d1082 », « d54 ». */
export function estReferenceRoutiere(noyau: string): boolean {
  return /^[dnm]\d+$/.test(noyau)
}

/**
 * Références routières que le dossier associe lui-même à un nom de voie, par la forme « Avenue de la
 * Libération (D1082) ».
 *
 * Le graphe ne conserve que le `name` des tronçons, jamais leur `ref` : un groupe qui désigne son
 * approche par « RD 1082 » ne peut être rattaché à aucun mouvement quand OSM nomme la voie « Avenue du
 * Général de Gaulle ». Le rapprochement ne se fait qu'à l'intérieur d'un même dossier : à l'échelle du
 * fichier, « D1082 » désigne tantôt l'Avenue de la Libération, tantôt l'Avenue du Général de Gaulle.
 */
export function referencesDuDossier(textes: string[]): Map<string, LibelleVoie> {
  const out = new Map<string, LibelleVoie>()
  for (const texte of textes) {
    const m = /^([^()]+?)\s*\(([^()]+)\)\s*$/.exec(texte.trim())
    if (!m) continue
    const nomme = normaliserVoie(m[1])
    const reference = normaliserVoie(m[2])
    if (!nomme || !reference) continue
    if (!estReferenceRoutiere(reference.noyau) || estReferenceRoutiere(nomme.noyau)) continue
    if (!out.has(reference.noyau)) out.set(reference.noyau, nomme)
  }
  return out
}

/* ------------------------------------------------------------------ */
/*  Côté d'une approche cité par un libellé de groupe                  */
/* ------------------------------------------------------------------ */

/** Angle de position (x vers l'est, y vers le nord) de chaque point cardinal, composés d'abord. */
const CARDINAUX: [string, number][] = [
  ['nord est', Math.PI / 4],
  ['nord ouest', (3 * Math.PI) / 4],
  ['sud ouest', (5 * Math.PI) / 4],
  ['sud est', (7 * Math.PI) / 4],
  ['nord', Math.PI / 2],
  ['ouest', Math.PI],
  ['sud', (3 * Math.PI) / 2],
  ['est', 0],
]

/**
 * Mots par lesquels un dossier annonce le côté d'une approche. Le point cardinal doit en suivre un :
 * sans cette exigence, « Rue de l'Est » ou « Avenue du Nord » passeraient pour des indications de côté.
 *
 * « direction » et « vers » en sont volontairement absents : ils désignent le sens de circulation
 * (« direction nord » = qui va vers le nord, donc qui vient du sud), soit le côté opposé.
 */
const ANNONCES_DE_COTE = ['venant', 'arrivee', 'arrivant', 'branche', 'cote', 'entree']

/** Articles qui séparent l'annonce du point cardinal (« venant du nord », « venant de l'ouest »). */
const ARTICLES_DE_COTE = /^(?:du|de la|de l|des|au|a l|le|la|l) /

/**
 * Côté par lequel un libellé de groupe distingue une approche d'une autre sur la même rue :
 * « véhicules venant du nord », « branche ouest », « côté sud », « (arrivée est) ».
 *
 * Rendu comme un angle de position vu du carrefour, directement comparable à l'angle d'approche d'un
 * mouvement (`Movement.inAngle`) et à celui de sa sortie (`outAngle`).
 */
export function coteDeVoie(brut: string): { angle: number; nom: string } | null {
  const texte = ` ${sansAccents(unifierPonctuation(brut).toLowerCase()).replace(/[^a-z]+/g, ' ').trim()} `
  for (const annonce of ANNONCES_DE_COTE) {
    let i = texte.indexOf(` ${annonce} `)
    while (i !== -1) {
      const suite = texte.slice(i + annonce.length + 2).replace(ARTICLES_DE_COTE, '')
      for (const [nom, angle] of CARDINAUX) {
        if (suite === nom || suite.startsWith(`${nom} `)) return { angle, nom }
      }
      i = texte.indexOf(` ${annonce} `, i + 1)
    }
  }
  return null
}

/** Écart angulaire absolu entre deux angles de position, dans [0, π]. */
function ecartAngulaire(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI)
  return d > Math.PI ? 2 * Math.PI - d : d
}

/* ------------------------------------------------------------------ */
/*  Heures et jours du calendrier                                      */
/* ------------------------------------------------------------------ */

const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']

function normaliserTexte(s: string): string {
  return sansAccents(unifierPonctuation(s).toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Toutes les heures d'un texte, en minutes depuis minuit (« 6h30-9h » → [390, 540]). */
export function heuresDuTexte(texte: string): number[] {
  const out: number[] = []
  const re = /(\d{1,2})\s*[h:.]\s*(\d{2})?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(texte))) {
    const h = Number(m[1])
    const min = m[2] ? Number(m[2]) : 0
    if (h > 24 || min > 59) continue
    out.push(h * 60 + min)
  }
  return out
}

/**
 * Toutes les plages d'un texte, en paires d'heures : « 07h00-09h00 et 16h30-19h00 » en donne deux.
 * Ne retenir que les deux premières heures ferait disparaître la tranche du soir sans le dire.
 */
export function plagesDuTexte(texte: string): { plages: [number, number][]; heureOrpheline: boolean } {
  const h = heuresDuTexte(texte)
  const plages: [number, number][] = []
  for (let i = 0; i + 1 < h.length; i += 2) plages.push([h[i], h[i + 1]])
  return { plages, heureOrpheline: h.length % 2 === 1 }
}

/** Une heure isolée (champ `debut`, `fin`), en minutes depuis minuit. */
export function heureEnMinutes(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Un nombre seul est une heure pleine (« 7 ») ; au-delà de 24 il est déjà exprimé en minutes.
    return v <= 24 ? Math.round(v * 60) : Math.round(v)
  }
  const s = chaine(v)
  if (!s) return null
  const heures = heuresDuTexte(s)
  if (heures.length) return heures[0]
  if (/^\d{1,2}$/.test(s)) {
    const h = Number(s)
    return h <= 24 ? h * 60 : null
  }
  return null
}

/**
 * Jours désignés par un libellé de type de jour, numérotés 1 (lundi) à 7 (dimanche).
 * Liste vide = tous les jours. `null` = libellé non reconnu (l'appelant avertit plutôt que de supposer).
 */
export function joursDuLibelle(brut: string): number[] | null {
  const s = normaliserTexte(brut)
  if (!s) return null
  if (/\b(tous|toute|toutes|tout|chaque|quotidien|permanent|7j|7 j)\b/.test(s)) return []
  const positions: { jour: number; index: number }[] = []
  for (let i = 0; i < JOURS.length; i++) {
    const idx = s.indexOf(JOURS[i])
    if (idx >= 0) positions.push({ jour: i + 1, index: idx })
  }
  positions.sort((a, b) => a.index - b.index)
  if (positions.length === 2) {
    const entre = s.slice(positions[0].index + JOURS[positions[0].jour - 1].length, positions[1].index)
    // « lundi_vendredi », « lundi au vendredi » : plage ; « samedi et dimanche » : énumération (même résultat ici).
    if (!/\bet\b/.test(entre) && positions[0].jour < positions[1].jour) {
      const out: number[] = []
      for (let j = positions[0].jour; j <= positions[1].jour; j++) out.push(j)
      return out
    }
  }
  if (positions.length) {
    const jours = new Set(positions.map((p) => p.jour))
    // Les jours fériés sont assimilés au dimanche, faute de calendrier civil dans le simulateur.
    if (/\bferie/.test(s)) jours.add(7)
    return [...jours].sort((a, b) => a - b)
  }
  if (/\b(semaine|ouvrable|ouvrables|ouvre|ouvres)\b/.test(s)) return [1, 2, 3, 4, 5]
  if (/\bweek\s?end\b/.test(s)) return [6, 7]
  if (/\bferie/.test(s)) return [7]
  return null
}

/* ------------------------------------------------------------------ */
/*  Conversion d'un dossier                                            */
/* ------------------------------------------------------------------ */

/** Un mouvement du carrefour, avec les libellés normalisés de son approche et de sa sortie. */
interface MouvementNomme {
  mouvement: Movement
  approche: LibelleVoie | null
  sortie: LibelleVoie | null
}

/**
 * Type d'un groupe d'après le libellé porté par le dossier, `null` si le libellé n'est pas reconnu.
 *
 * La reconnaissance est large parce que les dossiers écrivent aussi bien « pieton » que « traversée
 * piétonne » ou « TP » : un groupe piéton pris pour un groupe véhicule ouvrirait au vert protégé les
 * mouvements de la voie traversée, qu'il devrait au contraire se contenter de rendre permis (§14.5) — le
 * carrefour rendrait plus de débit qu'en réalité, et en conflit. Quand rien n'est reconnu,
 * l'appelant se rabat sur le préfixe de l'identifiant et le dit, plutôt que de supposer « véhicule ».
 */
export function typeDeGroupeDeclare(libelle: string): 'pieton' | 'vehicule' | null {
  const s = normaliserTexte(libelle)
  if (!s) return null
  if (/pieton/.test(s) || /travers/.test(s) || /(?:^|[^a-z])tp(?:[^a-z]|$)/.test(s)) return 'pieton'
  if (/vehicul/.test(s) || /voiture/.test(s) || /(?:^|[^a-z])(?:v|vl|vp)(?:[^a-z]|$)/.test(s)) return 'vehicule'
  return null
}

/**
 * Un dossier ne distingue pas le tourne-à-gauche à l'intérieur d'un groupe : il est donné « permis »,
 * comme dans le plan par défaut. Le déclarer protégé le ferait traverser le flux d'en face sans céder.
 */
function typeDeVert(m: Movement): GreenKind {
  return m.turn === 'left' || m.turn === 'uturn' ? 'permitted' : 'protected'
}

function slug(s: string): string {
  return sansAccents(s.toLowerCase()).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dossier'
}

function identifiantLibre(base: string, pris: Set<string>): string {
  if (!pris.has(base)) return base
  for (let i = 2; ; i++) {
    const candidat = `${base}_${i}`
    if (!pris.has(candidat)) return candidat
  }
}

/** Le jaune le plus fréquent du dossier sert de jaune par défaut du contrôleur (repli hors matrice). */
function jauneRepresentatif(parGroupe: Record<string, number>): number {
  const valeurs = Object.values(parGroupe).filter((v) => v > 0)
  if (!valeurs.length) return DEFAULT_SIGNAL_TIMING.amber
  const comptes = new Map<number, number>()
  for (const v of valeurs) comptes.set(v, (comptes.get(v) ?? 0) + 1)
  let meilleure = valeurs[0]
  let meilleurCompte = 0
  for (const [v, n] of comptes) {
    if (n > meilleurCompte || (n === meilleurCompte && v > meilleure)) { meilleure = v; meilleurCompte = n }
  }
  return meilleure
}

/** Mode de marche déduit du dossier : adaptatif ou fixe, avec ou sans escamotage des phases. */
interface Fonctionnement {
  mode: SignalController['mode']
  /** Sauter une phase sans demande : réservé à un véritable escamotage. */
  skipEmpty: boolean
  /** Ce qui a fait basculer en adaptatif, cité tel quel dans l'avertissement. */
  motif: string
  /** Le dossier se déclare en fonctionnement cyclique. */
  cyclique: boolean
}

/**
 * Le fonctionnement escamotable ou la prolongation sur détecteur donnent un contrôleur adaptatif, mais
 * les deux ne se valent pas : une phase escamotable ne s'ouvre que sur appel, alors qu'une phase
 * seulement prolongeable s'ouvre à chaque cycle et n'est jamais sautée. Confondre les deux ferait
 * disparaître du cycle des phases que le dossier ouvre systématiquement.
 */
function lireFonctionnement(dossier: Rec, phases: Rec[]): Fonctionnement {
  const identification = estObjet(dossier.identification) ? dossier.identification : {}
  const mode = identification.mode_fonctionnement
  const escamotages: string[] = []
  const prolongations: string[] = []
  let cyclique = false
  if (typeof mode === 'string') {
    const s = normaliserTexte(mode)
    if (/escamot/.test(s)) escamotages.push(`le mode de fonctionnement « ${mode.trim()} » de l'identification`)
    if (/cyclique/.test(s)) cyclique = true
  } else if (estObjet(mode)) {
    for (const [cle, valeur] of Object.entries(mode)) {
      if (valeur !== true) continue
      const s = normaliserTexte(cle)
      if (/escamot/.test(s)) escamotages.push(`la case « ${cle} » cochée à l'identification`)
      if (/cyclique/.test(s)) cyclique = true
    }
  }
  for (const phase of phases) {
    const nom = chaine(phase.nom) || 'sans nom'
    if (/escamot/.test(normaliserTexte(`${chaine(phase.nom)} ${chaine(phase.type)}`))) {
      escamotages.push(`la phase « ${nom} » déclarée escamotable`)
    } else if (renseigne(phase.appel)) {
      escamotages.push(`l'appel sur détecteur de la phase « ${nom} »`)
    } else if (renseigne(phase.prolongation) || renseigne(phase.regulation)) {
      prolongations.push(`la prolongation de vert sur détecteur de la phase « ${nom} »`)
    }
  }
  const escamotable = escamotages.length > 0
  const adaptatif = escamotable || prolongations.length > 0
  return {
    mode: adaptatif ? 'actuated' : 'fixed',
    skipEmpty: escamotable,
    motif: (escamotable ? escamotages : prolongations)[0] ?? '',
    cyclique,
  }
}

/** Intervalle véhicule (s) annoncé par la prolongation d'une phase, à défaut le temps de suite par défaut. */
function intervalleVehicule(phase: Rec): number {
  const source = phase.prolongation ?? phase.regulation
  if (source === undefined || source === null) return DEFAULT_SIGNAL_TIMING.gap
  const texte = typeof source === 'string' ? source : JSON.stringify(source)
  const m = /intervalle[^0-9]{0,30}(\d+(?:[.,]\d+)?)/i.exec(sansAccents(texte))
  if (!m) return DEFAULT_SIGNAL_TIMING.gap
  const v = Number(m[1].replace(',', '.'))
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SIGNAL_TIMING.gap
}

/* --------------------- Formes attendues et formes rencontrées --------------------- */

/** Clés qui trahissent un plan de feux donné seul, en objet, plutôt qu'en liste d'un seul élément. */
const CLES_DE_PLAN = ['nom', 'phases', 'cycle_s', 'periode', 'description', 'point_repos_s', 'regles']

/**
 * Plans de feux du dossier, quelle que soit la forme donnée à `plans_de_feux`.
 *
 * N'accepter que le tableau ferait disparaître sans un mot les réglages horaires d'un dossier qui donne
 * son plan unique en objet ou ses plans en dictionnaire : le contrôleur tournerait alors sur les seules
 * durées des phases, et le rapport d'import ne dirait rien.
 */
function lirePlansBruts(valeur: unknown, avertissements: string[]): Rec[] {
  if (valeur === undefined || valeur === null) return []
  if (Array.isArray(valeur)) {
    const plans = valeur.filter(estObjet)
    if (plans.length !== valeur.length) {
      avertissements.push(`Plans de feux : ${valeur.length - plans.length} entrée(s) ignorée(s), ce ne sont pas des objets.`)
    }
    return plans
  }
  if (estObjet(valeur)) {
    if (CLES_DE_PLAN.some((cle) => Object.prototype.hasOwnProperty.call(valeur, cle))) {
      avertissements.push(`Plans de feux : « plans_de_feux » est un objet et non une liste ; il a été lu comme un plan unique « ${chaine(valeur.nom) || 'sans nom'} ».`)
      return [valeur]
    }
    const entrees = Object.entries(valeur).filter(([, v]) => estObjet(v)) as [string, Rec][]
    if (entrees.length) {
      avertissements.push(`Plans de feux : « plans_de_feux » est un dictionnaire et non une liste ; ${entrees.length} plan(s) en ont été lus, chacun nommé par sa clé.`)
      return entrees.map(([cle, plan]) => (chaine(plan.nom) ? plan : { ...plan, nom: cle }))
    }
  }
  avertissements.push(`Plans de feux : « plans_de_feux » est ${typeDeValeur(valeur)} au lieu d'une liste et n'a pas pu être lu ; les verts minimaux et maximaux portés par les phases s'appliquent en permanence.`)
  return []
}

/** Clés d'une ligne de matrice donnée en tableau : le groupe qui perd le vert. */
const CLES_NOM_LIGNE = ['groupe', 'de', 'ligne', 'depuis', 'source', 'nom', 'id']
/** Clés d'entête d'une matrice, qui ne sont pas des lignes. */
const CLES_ENTETE_MATRICE = new Set(['convention', 'groupes', 'valeurs', 'valeur_jaune_s', 'valeur_securite_s',
  'vitesses_degagement_adoptees', 'note', 'notes', 'unite'])

/**
 * Clés de « valeur_jaune_s » (ou « valeur_securite_s ») qui désignent une CATÉGORIE de groupes et non un
 * groupe : c'est ainsi que les six dossiers réels écrivent la colonne de droite du tableau papier, une
 * valeur unique pour toutes les lignes véhicules.
 */
const CATEGORIES_VEHICULE = new Set(['vehicules', 'vehicule', 'vl', 'voitures', 'voiture', 'vp'])

/**
 * Colonne « jaune » de la matrice, ramenée à un index par groupe.
 *
 * Un dossier écrit aussi bien `{ "V1": 3 }` que `{ "vehicules": 3 }` ou un simple `3`. Prise pour un
 * identifiant de groupe, la clé « vehicules » ne correspond à aucun groupe : `amberByGroup` devient
 * inexploitable et le jaune du dossier disparaît du calcul des inter-verts (§14.3), remplacé sans un mot
 * par le jaune par défaut du contrôleur.
 *
 * Les valeurs nommément portées par un groupe l'emportent sur la valeur de catégorie : le dossier qui
 * précise une ligne l'a fait exprès.
 */
function valeursParGroupe(
  valeur: unknown,
  quoi: string,
  groupesVehicules: string[],
  groupesConnus: Set<string>,
  reservees: Set<string>,
  avertissements: string[],
): Record<string, number> {
  const out: Record<string, number> = {}
  const appliquerACategorie = (n: number, libelle: string): void => {
    if (!groupesVehicules.length) {
      avertissements.push(`${quoi} : la valeur ${libelle} vaut pour la catégorie « véhicules », mais le dossier ne déclare aucun groupe véhicule ; elle est ignorée.`)
      return
    }
    for (const g of groupesVehicules) out[g] = n
    avertissements.push(`${quoi} : la valeur ${libelle} désigne une catégorie et non un groupe ; elle est appliquée aux ${groupesVehicules.length} groupe(s) véhicule (${groupesVehicules.join(', ')}).`)
  }
  const scalaire = typeof valeur === 'number' || typeof valeur === 'string' ? nombre(valeur) : null
  if (scalaire !== null) {
    if (scalaire > 0) appliquerACategorie(scalaire, `${scalaire} s, donnée seule`)
    return out
  }
  if (!estObjet(valeur)) return out
  const inconnues: string[] = []
  const nommees: [string, number][] = []
  for (const [cle, v] of Object.entries(valeur)) {
    if (cleReservee(cle)) { reservees.add(cle); continue }
    const n = nombre(v)
    if (n === null || n <= 0) continue
    if (groupesConnus.has(cle)) { nommees.push([cle, n]); continue }
    if (CATEGORIES_VEHICULE.has(normaliserTexte(cle).replace(/ /g, ''))) appliquerACategorie(n, `« ${cle} » (${n} s)`)
    else inconnues.push(cle)
  }
  // Après les catégories : une ligne nommée dans le dossier prime sur la valeur commune.
  for (const [g, n] of nommees) out[g] = n
  if (inconnues.length) {
    avertissements.push(`${quoi} : clé(s) ${inconnues.map((k) => `« ${k} »`).join(', ')} sans correspondance, ni groupe du dossier ni catégorie de groupes ; valeur(s) ignorée(s).`)
  }
  return out
}

/** Matrice lue : ses lignes (groupe qui perd le vert → colonnes) et l'objet qui porte les jaunes. */
interface MatriceLue {
  entete: Rec
  lignes: [string, Rec][]
}

/** Lignes d'une matrice donnée en tableau : `[{ groupe: 'V1', valeurs: { P2: 5 } }]` ou à plat. */
function lignesEnTableau(items: unknown[]): [string, Rec][] {
  const out: [string, Rec][] = []
  for (const item of items) {
    if (!estObjet(item)) continue
    const cleNom = CLES_NOM_LIGNE.find((cle) => chaine(item[cle]))
    if (!cleNom) continue
    const colonnes = estObjet(item.valeurs) ? item.valeurs : estObjet(item.colonnes) ? item.colonnes : null
    if (colonnes) { out.push([chaine(item[cleNom]), colonnes]); continue }
    // Ligne à plat : les autres clés numériques sont les colonnes. Objet sans prototype pour que
    // `reste['__proto__']` reste une clé propre, filtrée et signalée plus loin comme toutes les autres.
    const reste = Object.create(null) as Rec
    for (const [cle, v] of Object.entries(item)) {
      if (cle !== cleNom && nombre(v) !== null) reste[cle] = v
    }
    out.push([chaine(item[cleNom]), reste])
  }
  return out
}

/**
 * Matrice d'inter-verts du dossier, quelle que soit la forme rencontrée.
 *
 * Sans matrice, le contrôleur retombe sur un jaune et un rouge intégral constants : les temps de sécurité
 * du dossier sont alors remplacés par des valeurs par défaut, ce qui ne peut pas rester silencieux.
 */
function lireMatriceInterVerts(valeur: unknown, avertissements: string[]): MatriceLue | null {
  const abandon = (raison: string): null => {
    avertissements.push(`Matrice d'inter-verts : ${raison} ; à défaut, le jaune et le rouge intégral par défaut du contrôleur séparent les phases.`)
    return null
  }
  if (valeur === undefined || valeur === null) return null
  if (Array.isArray(valeur)) {
    const lignes = lignesEnTableau(valeur)
    if (!lignes.length) return abandon(`la clé est une liste sans ligne exploitable`)
    avertissements.push(`Matrice d'inter-verts : donnée en tableau et non en objet ; ${lignes.length} ligne(s) en ont été lues.`)
    return { entete: {}, lignes }
  }
  if (!estObjet(valeur)) return abandon(`la clé est ${typeDeValeur(valeur)} au lieu d'un objet`)
  const valeurs = valeur.valeurs
  if (estObjet(valeurs)) {
    return { entete: valeur, lignes: Object.entries(valeurs).filter(([, l]) => estObjet(l)) as [string, Rec][] }
  }
  if (Array.isArray(valeurs)) {
    const lignes = lignesEnTableau(valeurs)
    if (!lignes.length) return abandon(`« valeurs » est une liste sans ligne exploitable`)
    avertissements.push(`Matrice d'inter-verts : « valeurs » donné en tableau de lignes ; ${lignes.length} ligne(s) en ont été lues.`)
    return { entete: valeur, lignes }
  }
  if (valeurs !== undefined) return abandon(`« valeurs » est ${typeDeValeur(valeurs)} au lieu d'un objet`)
  // Pas de clé « valeurs » : la matrice est peut-être donnée à plat, { V1: { P2: 5 } }.
  const lignes = Object.entries(valeur).filter(([cle, l]) => estObjet(l) && !CLES_ENTETE_MATRICE.has(cle)) as [string, Rec][]
  if (!lignes.length) return abandon(`aucune case n'a pu être lue (clé « valeurs » absente)`)
  avertissements.push(`Matrice d'inter-verts : clé « valeurs » absente ; les ${lignes.length} ligne(s) ont été lues à la racine de la matrice.`)
  return { entete: valeur, lignes }
}

/* --------------------- Rapprochement des libellés de plans --------------------- */

/** Libellé de plan réduit à sa forme comparable : « PF 1 », « pf-1 » et « PF1 » désignent le même plan. */
function clePlan(s: string): string {
  return normaliserTexte(s).replace(/ /g, '')
}

/**
 * Un libellé peut-il être le préfixe de l'autre ? Le reste doit être vide ou ne pas commencer par un
 * chiffre : sans cette réserve, « PF12 » serait rattaché au plan « PF1 », c'est-à-dire au mauvais plan.
 */
function prefixeCompatible(court: string, long: string): boolean {
  if (!long.startsWith(court)) return false
  const reste = long.slice(court.length)
  return reste === '' || !/^[0-9]/.test(reste)
}

/**
 * Jeu de mots d'un libellé de plan, trié et dédoublonné.
 *
 * Un dossier nomme son plan « PF1 - STR1 » et son calendrier le cite « STR1 - PF1 » : la chaîne ordonnée
 * ne les rapproche pas, alors qu'ils portent exactement les mêmes composants. Comparer l'ENSEMBLE des
 * mots, séparés par tirets, espaces ou barres, retrouve le plan sans rien inventer.
 */
function jeuDeComposants(libelle: string): string {
  const mots = normaliserTexte(libelle).split(' ').filter(Boolean)
  return [...new Set(mots)].sort().join(' ')
}

/** Plan du dossier désigné par un libellé, et si le rattachement vient d'un repli plutôt que d'une égalité. */
function resoudrePlan(
  libelle: string,
  plans: Map<string, { id: string; nom: string }>,
): { id: string; nom: string; repli: boolean } | null {
  const cle = clePlan(libelle)
  if (!cle) return null
  const exact = plans.get(cle)
  if (exact) return { ...exact, repli: false }
  // Même jeu de composants dans un autre ordre : rattachement annoncé comme un repli, jamais silencieux.
  const jeu = jeuDeComposants(libelle)
  if (jeu) {
    const memesMots = [...plans.values()].filter((p) => jeuDeComposants(p.nom) === jeu)
    // Deux plans aux mêmes mots ne se départagent pas : mieux vaut ne rien rattacher que se tromper.
    if (memesMots.length === 1) return { ...memesMots[0], repli: true }
  }
  for (const [cleConnue, plan] of plans) {
    if (prefixeCompatible(cle, cleConnue) || prefixeCompatible(cleConnue, cle)) return { ...plan, repli: true }
  }
  return null
}

/**
 * Libellé de phase comparable : le préfixe « Phase » (ou « Plan ») retiré, de part et d'autre.
 *
 * Les dossiers nomment leurs phases « Phase A Repos » et les plans de feux les citent « A Repos ». Sans
 * retirer ce préfixe, aucun réglage propre au plan n'est retrouvé : les mini et maxi du plan sont ignorés
 * et le carrefour tourne sur les seules durées portées par la liste des phases — parfois nulles.
 *
 * L'apostrophe est conservée, contrairement au reste de la ponctuation : elle distingue « Phase A' » de
 * « Phase A », deux phases bien différentes dans les dossiers réels.
 */
function cleNomPhase(nom: string): string {
  return sansAccents(unifierPonctuation(nom).toLowerCase()).replace(/[^a-z0-9']+/g, ' ').trim()
}

function clePhase(nom: string): string {
  return cleNomPhase(nom).replace(/^(?:phases?|plans?)\s+/, '').trim()
}

/**
 * Nombre de mots alignés entre deux libellés de phase, `-1` s'ils sont incompatibles.
 *
 * Les dossiers abrègent (« B escam » pour « Phase B escamotable ») ou précisent (« B rappel » pour la
 * phase « B ») : l'alignement mot à mot départage ces deux replis, là où une simple comparaison de
 * préfixes rattacherait « B escam » à la phase « B » aussi bien qu'à « B escamotable ». Seul le dernier
 * mot comparé peut être une abréviation, et jamais au point de confondre « 1 » et « 12 ».
 */
function alignementMots(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length)
  if (!n) return -1
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue
    if (i === n - 1 && (prefixeCompatible(a[i], b[i]) || prefixeCompatible(b[i], a[i]))) return n
    return -1
  }
  return n
}

/* ----------------------------- Calendrier ----------------------------- */

const CLES_PLAN = ['plan', 'plan_de_feux', 'plan_de_feu', 'plan_feux', 'nom_plan', 'plan_applique', 'pf']
const CLES_HORAIRE = ['plage', 'plage_horaire', 'plages_horaires', 'horaire', 'horaires', 'heures', 'heure',
  'periode', 'tranche', 'tranche_horaire', 'creneau']
const CLES_JOURS = ['jours', 'jour', 'type_jour', 'type_de_jour', 'types_jours', 'jour_type', 'jours_semaine']
const PAIRES_DEBUT_FIN: [string, string][] = [
  ['debut', 'fin'], ['heure_debut', 'heure_fin'], ['debut_h', 'fin_h'], ['de', 'a'], ['from', 'to'], ['start', 'end'],
]

/**
 * Clés qui structurent un calendrier sans désigner un type de jour : leur libellé ne doit pas être
 * signalé comme « type de jour non reconnu », faute de quoi chaque dossier bien formé produirait un
 * avertissement inutile.
 */
const CLES_STRUCTURE_CALENDRIER = new Set([
  ...CLES_PLAN, ...CLES_HORAIRE, ...CLES_JOURS,
  'calendrier', 'plages', 'periodes', 'programme', 'programmes', 'entrees', 'liste', 'lignes', 'regles',
  'note', 'notes', 'commentaire', 'saison', 'saisons',
])

interface EntreeCalendrier {
  plan: string
  fromMin: number
  toMin: number
  jours: number[]
  /** Libellé de jour non reconnu, à signaler à l'exploitant. */
  joursDouteux?: string
  /** Plage horaire absente : le plan a été supposé applicable toute la journée. */
  horaireSuppose?: boolean
  /** Texte d'horaire dont une heure n'a pas pu être appariée, à signaler tel quel. */
  horaireOrphelin?: string
}

function premiereValeur(obj: Rec, cles: string[]): unknown {
  for (const c of cles) {
    // Propriétés propres seulement : un `Object.prototype` pollué par ailleurs inventerait un plan de feux.
    if (!Object.prototype.hasOwnProperty.call(obj, c)) continue
    if (obj[c] !== undefined && obj[c] !== null) return obj[c]
  }
  return undefined
}

/** Toutes les entrées portées par un objet du calendrier : une par plage horaire trouvée. */
function extraireEntrees(obj: Rec, jours: number[] | null, joursBrut: string, horaireContexte: string): EntreeCalendrier[] {
  const plan = chaine(premiereValeur(obj, CLES_PLAN))
  if (!plan) return []
  let plages: [number, number][] = []
  let orphelin: string | undefined
  const horaire = premiereValeur(obj, CLES_HORAIRE)
  if (typeof horaire === 'string') {
    const lu = plagesDuTexte(horaire)
    plages = lu.plages
    if (lu.plages.length && lu.heureOrpheline) orphelin = horaire
  }
  if (!plages.length) {
    for (const [cd, cf] of PAIRES_DEBUT_FIN) {
      const d = heureEnMinutes(obj[cd])
      const f = heureEnMinutes(obj[cf])
      if (d !== null && f !== null) { plages = [[d, f]]; break }
    }
  }
  if (!plages.length && horaireContexte) {
    const lu = plagesDuTexte(horaireContexte)
    plages = lu.plages
    if (lu.plages.length && lu.heureOrpheline) orphelin = horaireContexte
  }
  const joursObjet = chaine(premiereValeur(obj, CLES_JOURS))
  const joursFinaux = joursObjet ? joursDuLibelle(joursObjet) : jours
  const libelleJours = joursObjet || joursBrut
  const commun = {
    plan,
    jours: joursFinaux ?? [],
    joursDouteux: joursFinaux === null && libelleJours ? libelleJours : undefined,
  }
  if (!plages.length) return [{ ...commun, fromMin: 0, toMin: 24 * 60, horaireSuppose: true }]
  return plages.map(([d, f]) => ({ ...commun, fromMin: d, toMin: f, horaireOrphelin: orphelin }))
}

/**
 * Parcourt un calendrier de forme inconnue : les dossiers rangent les plages tantôt par type de jour,
 * tantôt par plage horaire, tantôt à plat. On collecte les couples (plan, plage, jours) où qu'ils soient.
 */
function collecterCalendrier(
  valeur: unknown,
  jours: number[] | null,
  joursBrut: string,
  horaire: string,
  out: EntreeCalendrier[],
  profondeur = 0,
): void {
  if (profondeur > 5 || out.length > 200) return
  if (Array.isArray(valeur)) {
    for (const item of valeur) collecterCalendrier(item, jours, joursBrut, horaire, out, profondeur + 1)
    return
  }
  if (!estObjet(valeur)) return
  const entrees = extraireEntrees(valeur, jours, joursBrut, horaire)
  if (entrees.length) { out.push(...entrees); return }
  for (const [cle, v] of Object.entries(valeur)) {
    const lu = plagesDuTexte(cle)
    const joursCle = joursDuLibelle(cle)
    if (typeof v === 'string' && (lu.plages.length || joursCle !== null)) {
      // Formes compactes { "06:00-09:00": "PF1" } ou { "lundi_vendredi": "PF1" }.
      const commun = { plan: v, jours: (joursCle ?? jours) ?? [], joursDouteux: undefined }
      if (!lu.plages.length) out.push({ ...commun, fromMin: 0, toMin: 24 * 60, horaireSuppose: true })
      else {
        for (const [d, f] of lu.plages) {
          out.push({ ...commun, fromMin: d, toMin: f, horaireOrphelin: lu.heureOrpheline ? cle : undefined })
        }
      }
      continue
    }
    // Une clé non reconnue qui n'est pas une clé de structure est un type de jour illisible : la
    // propager permet à l'avertissement de partir, au lieu d'appliquer la plage « tous les jours ».
    const structurelle = CLES_STRUCTURE_CALENDRIER.has(normaliserTexte(cle).replace(/ /g, '_'))
      || lu.plages.length > 0 || /^\d+$/.test(cle.trim())
    collecterCalendrier(
      v,
      joursCle ?? jours,
      joursCle !== null || !structurelle ? cle : joursBrut,
      lu.plages.length ? cle : horaire,
      out,
      profondeur + 1,
    )
  }
}

/* ------------------------------------------------------------------ */
/*  Point d'entrée                                                     */
/* ------------------------------------------------------------------ */

/**
 * Clés qui trahissent un dossier de carrefour posé à la racine d'un fichier. Aucune n'est obligatoire
 * — les dossiers sont hétérogènes — mais un fichier qui n'en porte aucune ne décrit pas un carrefour :
 * le dire vaut mieux que poser un plan vide sur le feu de l'exploitant.
 */
const CLES_DE_DOSSIER = ['groupes', 'phases', 'plans_de_feux', 'plan_de_feux', 'matrice_inter_verts',
  'matrice_rouges_degagement', 'calendrier', 'identification', 'voies']

function estDossierDeCarrefour(v: Rec): boolean {
  return CLES_DE_DOSSIER.some((cle) => renseigne(v[cle]))
}

/**
 * Le dossier porté par le fichier choisi, ou `null` avec la raison.
 *
 * Le format est **un carrefour par fichier** : le dossier est à la racine, sous les métadonnées de la
 * commune. Un fichier de l'ancien format, qui rassemblait plusieurs dossiers dans une liste
 * « carrefours », reste lu s'il n'en contient qu'un ; s'il en contient plusieurs, l'import s'arrête et
 * les énumère, car rien ne dit lequel décrit le feu que l'exploitant vient de désigner.
 */
function lireDossierUnique(raw: unknown): { dossier: Rec | null; avertissements: string[] } {
  const echec = (m: string): { dossier: null; avertissements: string[] } => ({ dossier: null, avertissements: [m] })

  let valeur = raw
  if (typeof valeur === 'string') {
    const texte = valeur.trim()
    if (!texte) return echec('Le fichier est vide.')
    try {
      valeur = JSON.parse(texte)
    } catch {
      return echec("Le fichier n'est pas un JSON valide : aucun dossier n'a pu être lu.")
    }
  }
  if (valeur === null || valeur === undefined) return echec('Aucun contenu à importer.')

  let liste: unknown
  if (Array.isArray(valeur)) liste = valeur
  else if (estObjet(valeur)) {
    liste = valeur.carrefours ?? valeur.dossiers
    // Un dossier seul à la racine : c'est le format courant, un fichier par carrefour.
    if (liste === undefined) {
      if (!estDossierDeCarrefour(valeur)) {
        return echec("Le fichier ne décrit aucun dossier de carrefour : ni groupes, ni phases, ni matrice d'inter-verts.")
      }
      return { dossier: valeur, avertissements: [] }
    }
  } else {
    return echec("Le contenu n'est pas un objet JSON : ce n'est pas un dossier de carrefour.")
  }
  if (!Array.isArray(liste)) {
    return echec("Le fichier ne contient ni dossier de carrefour, ni liste « carrefours » : rien à importer.")
  }
  const carrefours = liste.filter(estObjet)
  if (!carrefours.length) return echec("Le fichier ne contient aucun dossier de carrefour.")
  if (carrefours.length === 1) return { dossier: carrefours[0], avertissements: [] }
  const ids = carrefours.map((d, i) => chaine(d.id) || chaine(d.nom) || `dossier ${i + 1}`).join(', ')
  return echec(`Le fichier contient ${carrefours.length} dossiers (${ids}) : il en faut un seul, celui du carrefour choisi.`)
}

/** Dossier lu, réduit à ce que la conversion utilise. */
interface DossierLu {
  dossier: Rec
  dossierId: string
  nom: string
  groupes: Rec[]
}

/** Textes bruts où un dossier nomme des voies : entête, voies des groupes, et son propre nom. */
function textesDeVoies(dossier: Rec, groupes: Rec[]): string[] {
  return [
    ...listeDeChaines(dossier.voies ?? dossier.voies_plan),
    ...groupes.flatMap((g) => listeDeChaines(g.voie)),
    chaine(dossier.nom),
  ]
}

/**
 * Applique au carrefour désigné le dossier porté par le fichier choisi.
 *
 * Le contrôleur rendu garde l'identifiant et les nœuds de celui qui est en place : le dossier remplace
 * son plan (groupes, phases, plans horaires, calendrier, inter-verts), il ne crée pas un second feu.
 * Rien n'est modifié quand le fichier est illisible ou que le carrefour n'est plus à feux.
 */
export function importDossierFeux(contenu: unknown, opts: DossierImportOptions): DossierImportResult {
  const rien = (avertissements: string[], dossierId = '', nom = ''): DossierImportResult => ({
    controller: null, dossierId, nom, groupesRattaches: 0, groupesNonRattaches: [], avertissements,
  })
  try {
    const { dossier, avertissements } = lireDossierUnique(contenu)
    if (!dossier) return rien(avertissements)

    const dossierId = chaine(dossier.id) || chaine(dossier.nom) || 'sans numéro'
    const nom = chaine(dossier.nom) || dossierId
    const groupes = tableau(dossier.groupes).filter(estObjet)

    const existant = opts.network.controllers[opts.controllerId]
    if (!existant) {
      return rien([...avertissements, "Ce carrefour n’est plus à feux : le dossier n’a pas été appliqué."], dossierId, nom)
    }

    const adj = buildAdjacency(opts.network)
    const construit = construireControleur(
      { dossier, dossierId, nom, groupes },
      existant.id,
      existant.nodeIds,
      opts.network,
      adj,
      avertissements,
    )
    return {
      controller: construit.controleur,
      dossierId,
      nom,
      groupesRattaches: construit.rattaches,
      groupesNonRattaches: construit.nonRattaches,
      avertissements,
    }
  } catch (err) {
    return rien([`Le dossier n’a pas pu être converti (${message(err)}) : le carrefour n’a pas été modifié.`])
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* ------------------------------------------------------------------ */
/*  Construction du contrôleur                                        */
/* ------------------------------------------------------------------ */

interface ControleurConstruit {
  controleur: SignalController
  rattaches: number
  nonRattaches: string[]
}

function construireControleur(
  c: DossierLu,
  controllerId: ControllerId,
  nodeIds: NodeId[],
  network: Network,
  adj: Adjacency,
  avertissements: string[],
): ControleurConstruit {
  const stub: SignalController = {
    id: controllerId, name: c.nom, nodeIds, mode: 'fixed', offset: 0,
    amber: DEFAULT_SIGNAL_TIMING.amber, allRed: DEFAULT_SIGNAL_TIMING.allRed, phases: [],
    actuated: { skipEmpty: true },
  }
  const mouvements: MouvementNomme[] = controllerMovements(network, stub, adj).map((m) => ({
    mouvement: m,
    approche: network.edges[m.from]?.name ? normaliserVoie(network.edges[m.from].name as string) : null,
    sortie: network.edges[m.to]?.name ? normaliserVoie(network.edges[m.to].name as string) : null,
  }))
  const typeParCle = new Map<MovementKey, GreenKind>()
  for (const m of mouvements) typeParCle.set(m.mouvement.key, typeDeVert(m.mouvement))

  /* --- Groupes --- */
  const phasesBrutes = ordonnerPhases(c.dossier, avertissements)
  const rappelParGroupe = new Set<string>()
  for (const phase of phasesBrutes) {
    if (phase.pietons_en_rappel === true) for (const g of listeDeChaines(phase.pietons)) rappelParGroupe.add(g)
  }
  const groupes: SignalGroup[] = []
  const nonRattaches: string[] = []
  const voiesDeGroupes = new Map<string, string[]>()
  /** Côté (point cardinal) que chaque groupe déclare, quand son libellé en cite un. */
  const cotesDeGroupes = new Map<string, { angle: number; nom: string }>()
  /** Voies servant à reconnaître les mouvements de chaque groupe, références routières résolues. */
  const voiesDeGroupe = new Map<string, LibelleVoie[]>()
  // Table « référence routière → nom de voie » construite sur le dossier lui-même (§ défaut RD).
  const references = referencesDuDossier(textesDeVoies(c.dossier, c.groupes))
  /** Références rapprochées d'un nom de voie du dossier, à annoncer : c'est un repli, pas une lecture. */
  const referencesRattachees = new Set<string>()
  /** Groupes dont la voie n'est qu'une référence routière que rien ne permet de nommer. */
  const referencesOrphelines = new Map<string, string>()
  let pietonApproximatif = false
  const idsDeGroupes = new Set<string>()
  for (const brut of c.groupes) {
    const id = chaine(brut.id)
    if (!id) { avertissements.push('Un groupe sans identifiant a été ignoré.'); continue }
    if (idsDeGroupes.has(id)) {
      // Phases et matrices désignent les groupes par leur identifiant : sur un doublon, seul le dernier
      // est retenu et le premier n'ouvre plus rien. C'est une erreur de saisie du dossier, pas un choix.
      avertissements.push(`Deux groupes portent l'identifiant « ${id} » : seul le dernier est retenu par les phases et les inter-verts.`)
    }
    idsDeGroupes.add(id)
    const typeDeclare = chaine(brut.type)
    const typeReconnu = typeDeGroupeDeclare(typeDeclare)
    // Type illisible ou absent : le préfixe de l'identifiant tranche (P1, TP2 = piéton).
    const type: SignalGroup['type'] = typeReconnu ?? (/^(?:tp|p)/i.test(id) ? 'pieton' : 'vehicule')
    if (!typeReconnu && typeDeclare) {
      avertissements.push(`Groupe ${id} : type « ${typeDeclare} » non reconnu ; groupe traité comme ${type === 'pieton' ? 'piéton' : 'véhicule'} d'après le préfixe de son identifiant.`)
    }
    const voies = libellesDeVoies(brut.voie)
    // Le côté est lu sur le libellé ENTIER : découpé par `libellesDeVoies`, « véhicules venant du
    // nord » devient un fragment de voie à part et l'indication se perdrait.
    const cote = coteDeVoie(listeDeChaines(brut.voie).join(' / '))
    if (cote) cotesDeGroupes.set(id, cote)
    // Une approche désignée par sa seule référence routière ne correspond à aucun nom du réseau : on lui
    // substitue, pour la comparaison, le nom que le dossier associe lui-même à cette référence.
    const voiesComparables: LibelleVoie[] = []
    for (const v of voies) {
      if (!estReferenceRoutiere(v.noyau)) { voiesComparables.push(v); continue }
      const nomme = references.get(v.noyau)
      if (nomme) {
        voiesComparables.push(nomme)
        referencesRattachees.add(`« ${v.brut} » → « ${nomme.brut} »`)
      } else {
        voiesComparables.push(v)
        referencesOrphelines.set(id, v.brut)
      }
    }
    voiesDeGroupe.set(id, voiesComparables)
    const movements: MovementKey[] = []
    for (const m of mouvements) {
      const concerne = type === 'vehicule'
        ? voiesComparables.some((v) => m.approche && memeVoie(v, m.approche))
        // Faute de géométrie fiable dans le dossier, une traversée est réputée franchie par tout mouvement
        // qui entre ou sort par la voie traversée.
        : voiesComparables.some((v) => (m.approche && memeVoie(v, m.approche)) || (m.sortie && memeVoie(v, m.sortie)))
      if (concerne) movements.push(m.mouvement.key)
    }
    if (type === 'pieton' && movements.length) pietonApproximatif = true
    const groupe: SignalGroup = { id, type, movements }
    if (voies.length) groupe.label = voies.map((v) => v.brut).join(' / ')
    if (rappelParGroupe.has(id) || brut.rappel === true || brut.pietons_en_rappel === true) groupe.recall = true
    groupes.push(groupe)
    if (!movements.length) nonRattaches.push(id)
    if (chaine(brut.source_voie)) {
      avertissements.push(`Groupe ${id} : la voie « ${voies.map((v) => v.brut).join(' / ') || '?'} » vient de la lecture du plan (source_voie) et reste à confirmer.`)
    }
    for (const v of voiesComparables) {
      const liste = voiesDeGroupes.get(`${type}:${v.noyau}`)
      if (liste) liste.push(id)
      else voiesDeGroupes.set(`${type}:${v.noyau}`, [id])
    }
  }
  /*
   * Deux groupes sur la même rue, distingués par le seul côté.
   *
   * Un dossier nomme couramment deux approches d'une même voie « véhicules venant du nord » et
   * « … du sud ». Comparés sur le seul nom de rue, les deux groupes commandent les mêmes mouvements :
   * la phase qui n'ouvre que le nord ouvre aussi le sud, et le carrefour simulé écoule un trafic que le
   * carrefour réel arrête. Quand chaque groupe cite un côté distinct, les mouvements sont répartis
   * d'après la géométrie du carrefour : chacun revient au groupe dont le côté est le plus proche de son
   * angle d'approche (véhicules), ou de l'un de ses deux angles pour une traversée piétonne — un
   * mouvement qui traverse le carrefour de part en part franchit bien les deux traversées.
   *
   * La répartition est annoncée et reste à vérifier : elle est déduite du plan, pas lue au dossier. Si
   * elle laissait un groupe sans mouvement, elle est abandonnée au profit de l'ancien comportement,
   * qui ouvre trop mais ne ferme rien à tort.
   */
  const mouvementParCle = new Map<MovementKey, MouvementNomme>(mouvements.map((m) => [m.mouvement.key, m]))
  const dejaReparties = new Set<string>()
  for (const [cle, ids] of voiesDeGroupes) {
    const uniques = [...new Set(ids)]
    if (uniques.length < 2) continue
    const signature = uniques.join(',')
    if (dejaReparties.has(signature)) continue
    const type = cle.startsWith('pieton:') ? 'pieton' : 'vehicule'
    const voie = cle.slice(type.length + 1)
    const cotes = uniques.map((id) => cotesDeGroupes.get(id))
    const distincts = new Set(cotes.map((c) => c?.nom))
    /** Aucun côté exploitable : les deux groupes gardent les mêmes mouvements, et l'exploitant le sait. */
    const signalerIdentiques = (): void => {
      if (type !== 'vehicule') return
      avertissements.push(`Groupes ${uniques.join(', ')} : même voie « ${voie} », leurs mouvements sont identiques faute de distinction dans le dossier.`)
    }
    if (cotes.some((c) => !c) || distincts.size !== uniques.length) { signalerIdentiques(); continue }

    /** Groupe dont le côté déclaré est le plus proche de cet angle de position. */
    const plusProche = (angle: number): string => {
      let gagnant = uniques[0]
      let meilleur = Infinity
      for (const id of uniques) {
        const ecart = ecartAngulaire(angle, cotesDeGroupes.get(id)!.angle)
        if (ecart < meilleur) { meilleur = ecart; gagnant = id }
      }
      return gagnant
    }
    const retenus = new Map<string, Set<MovementKey>>(uniques.map((id) => [id, new Set<MovementKey>()]))
    for (const id of uniques) {
      const voies = voiesDeGroupe.get(id) ?? []
      for (const k of groupes.find((g) => g.id === id)?.movements ?? []) {
        const m = mouvementParCle.get(k)
        if (!m) continue
        // Seuls comptent les tronçons qui portent VRAIMENT la voie du groupe : la sortie d'un mouvement
        // qui entre par l'avenue et repart par une transversale ne dit rien du côté de l'avenue.
        const angles: number[] = []
        if (m.approche && voies.some((v) => memeVoie(v, m.approche!))) angles.push(m.mouvement.inAngle)
        if (type === 'pieton' && m.sortie && voies.some((v) => memeVoie(v, m.sortie!))) angles.push(m.mouvement.outAngle)
        if (angles.some((a) => plusProche(a) === id)) retenus.get(id)!.add(k)
      }
    }
    if (uniques.some((id) => retenus.get(id)!.size === 0)) { signalerIdentiques(); continue }
    for (const id of uniques) {
      const groupe = groupes.find((g) => g.id === id)
      if (groupe) groupe.movements = groupe.movements.filter((k) => retenus.get(id)!.has(k))
    }
    dejaReparties.add(signature)
    const reparti = uniques.map((id) => `${id} (${cotesDeGroupes.get(id)!.nom})`).join(', ')
    avertissements.push(`Groupes ${reparti} : même voie « ${voie} », leurs mouvements ont été répartis d’après le côté que le dossier cite et la géométrie du carrefour ; à vérifier sur le plan.`)
  }
  if (pietonApproximatif) {
    avertissements.push('Traversées piétonnes : les mouvements que chaque traversée franchit ont été déduits du nom de la voie traversée (entrée ou sortie), le dossier ne donnant pas la géométrie des traversées. Une traversée verte ne ferme pas ces mouvements, elle leur retire seulement la protection (§14.5) : un mouvement rattaché à tort perd sa protection sans être fermé.')
  }
  if (referencesRattachees.size) {
    avertissements.push(`Référence(s) routière(s) rapprochée(s) d'un nom de voie d'après les libellés du dossier : ${[...referencesRattachees].join(', ')} ; le réseau ne conservant pas les numéros de route, ce rapprochement est à vérifier.`)
  }
  // Cause exacte, plutôt que le message générique : un groupe dont la voie n'est qu'un numéro de route
  // n'a rien à voir avec la géométrie approximative des traversées piétonnes, et l'envoyer sur cette
  // piste ferait chercher un défaut là où il n'y en a pas.
  const orphelines = [...referencesOrphelines].filter(([g]) => nonRattaches.includes(g))
  if (orphelines.length) {
    avertissements.push(`Groupe(s) ${orphelines.map(([g, r]) => `${g} (voie « ${r} »)`).join(', ')} : la voie n'est désignée que par sa référence routière. Le réseau ne retient que le nom des voies, et le dossier n'associe cette référence à aucun nom (aucun libellé de la forme « Avenue … (D1082) ») : ces groupes restent sans mouvement tant que l'exploitant n'a pas nommé la voie.`)
  }
  if (nonRattaches.length) {
    avertissements.push(`${nonRattaches.length} groupe(s) sans mouvement au carrefour : ${nonRattaches.join(', ')}.`)
  }
  const groupesConnus = new Set(groupes.map((g) => g.id))
  const parGroupe = new Map(groupes.map((g) => [g.id, g]))

  /* --- Phases --- */
  const phases: SignalPhase[] = []
  const idParNom = new Map<string, string>()
  /** Même index, le préfixe « Phase » retiré : c'est sous cette forme que les plans citent les phases. */
  const idParNomCourt = new Map<string, string>()
  /** Libellés courts que deux phases se partagent : impossibles à départager, donc jamais rattachés. */
  const nomsCourtsAmbigus = new Set<string>()
  const idParLettre = new Map<string, string>()
  /** Plan propre à une phase : libellé du dossier et forme comparable, pour parler à l'exploitant. */
  const planDeLaPhase = new Map<string, { brut: string; cle: string }>()
  phasesBrutes.forEach((brut, i) => {
    const nom = chaine(brut.nom) || `Phase ${i + 1}`
    const idPhase = `p${i + 1}`
    const { mini, maxi } = bornesDeVert(brut.mini_s, brut.maxi_s, `Phase « ${nom} »`, avertissements)
    const ids = [...listeDeChaines(brut.vehicules), ...listeDeChaines(brut.pietons)]
    const inconnus = ids.filter((g) => !groupesConnus.has(g))
    if (inconnus.length) {
      avertissements.push(`Phase « ${nom} » : groupe(s) inconnu(s) ${inconnus.join(', ')} ignoré(s).`)
    }
    const retenus = ids.filter((g) => groupesConnus.has(g))
    const movements: Record<MovementKey, GreenKind> = {}
    const vehiculesDeLaPhase: string[] = []
    for (const g of retenus) {
      const groupe = parGroupe.get(g)
      if (groupe?.type !== 'vehicule') continue
      vehiculesDeLaPhase.push(g)
      for (const k of groupe.movements) movements[k] = typeParCle.get(k) ?? 'protected'
    }
    // §14.5 : une traversée verte en même temps que le groupe véhicule de sa branche ne ferme AUCUN
    // mouvement, elle les fait passer de « protégé » à « permis » — le conducteur qui tourne a le vert et
    // cède aux piétons. Rien n'est donc retiré de `movements` ici. Deux raisons : le moteur redérive de
    // toute façon les verts depuis les groupes (`phaseMovements`), donc le retrait était sans effet sur la
    // simulation ; et il rendait `phase.movements` — que lisent la carte et le schéma de phase — différent
    // de ce qui est simulé. Le déclassement en « permis » n'est pas écrit ici non plus : il dépend du cycle,
    // une traversée sur bouton poussoir laissant le vert protégé les cycles où personne n'appuie (§14.5),
    // et c'est `phaseMovements` qui l'applique. Les traversées ne servent donc ici qu'à avertir.
    const franchisParPieton = new Set<MovementKey>()
    /** Traversées de la phase qui franchissent au moins un mouvement ouvert : les seules à nommer. */
    const traverseesFranchissantes: string[] = []
    for (const g of retenus) {
      const groupe = parGroupe.get(g)
      if (groupe?.type !== 'pieton') continue
      const franchis = groupe.movements.filter((k) => k in movements)
      if (franchis.length) traverseesFranchissantes.push(g)
      for (const k of franchis) franchisParPieton.add(k)
    }
    const ouverts = Object.keys(movements).length
    if (retenus.length && !ouverts) {
      // Deux causes très différentes : parler de traversées piétonnes quand la phase n'ouvre rien
      // enverrait le technicien sur une fausse piste, le défaut est ailleurs.
      if (vehiculesDeLaPhase.length) {
        avertissements.push(`Phase « ${nom} » : aucun mouvement au vert, le(s) groupe(s) véhicule ${vehiculesDeLaPhase.join(', ')} n'étant rattaché(s) à aucune approche du carrefour.`)
      } else {
        avertissements.push(`Phase « ${nom} » : aucun mouvement au vert, la phase ne comporte aucun groupe véhicule.`)
      }
    } else if (ouverts && franchisParPieton.size === ouverts) {
      // Ce que l'exploitant ne peut pas deviner du dossier : cette phase n'ouvre plus un seul vert
      // protégé, tous ses mouvements cèdent aux piétons. Sa capacité simulée est donc majorée, le moteur
      // ne disposant d'aucune demande piétonne pour calculer les créneaux (§14.5, limite assumée).
      // Une traversée sur bouton poussoir n'est pas desservie à tous les cycles : le dire évite de faire
      // chercher un vert protégé que le carrefour donne bel et bien, mais seulement une partie du temps.
      const surAppel = traverseesFranchissantes.filter((g) => !parGroupe.get(g)?.recall)
      const reserveAppel = surAppel.length
        ? ` Sur bouton poussoir (${surAppel.join(', ')}), le vert redevient protégé les cycles où personne n'appuie.`
        : ''
      avertissements.push(`Phase « ${nom} » : ses ${ouverts} mouvement(s) au vert sont tous franchis par une traversée piétonne verte de la même phase (${traverseesFranchissantes.join(', ')}). Ils restent au vert mais en cession (vert permis, aucun vert protégé) et leur capacité simulée est optimiste, le dossier ne portant aucune demande piétonne.${reserveAppel}`)
    }
    const phase: SignalPhase = {
      id: idPhase,
      name: nom,
      green: mini ?? DEFAULT_SIGNAL_TIMING.minGreen,
      movements,
      minGreen: mini ?? DEFAULT_SIGNAL_TIMING.minGreen,
      maxGreen: maxi ?? mini ?? DEFAULT_SIGNAL_TIMING.maxGreen,
      gap: intervalleVehicule(brut),
    }
    if (retenus.length) phase.groups = retenus
    phases.push(phase)
    const cle = cleNomPhase(nom)
    if (cle && !idParNom.has(cle)) idParNom.set(cle, idPhase)
    else if (cle) avertissements.push(`Deux phases portent le même nom « ${nom} » : la seconde ne pourra pas être référencée par un plan.`)
    const court = clePhase(nom)
    if (court && !idParNomCourt.has(court)) idParNomCourt.set(court, idPhase)
    else if (court && idParNomCourt.get(court) !== idPhase) nomsCourtsAmbigus.add(court)
    const lettre = /\bphase\s+([a-z0-9]+)\b/.exec(cle)?.[1] ?? (/^[a-z0-9]$/.test(cle) ? cle : '')
    if (lettre) {
      if (idParLettre.has(lettre)) idParLettre.set(lettre, '')
      else idParLettre.set(lettre, idPhase)
    }
    const planPropre = chaine(brut.plan)
    if (planPropre) planDeLaPhase.set(idPhase, { brut: planPropre, cle: clePlan(planPropre) })
  })
  if (!phases.length) avertissements.push('Le dossier ne décrit aucune phase : le contrôleur reste sans plan.')
  for (const court of nomsCourtsAmbigus) {
    const nomsEnCause = phases.filter((p) => clePhase(p.name) === court).map((p) => `« ${p.name} »`).join(', ')
    avertissements.push(`Phases ${nomsEnCause} : leurs noms sont indiscernables une fois le préfixe « Phase » retiré ; un plan qui les cite ne pourra pas les départager, leurs réglages propres au plan sont ignorés.`)
  }

  const resoudrePhase = (libelle: string): string | null => {
    const cle = cleNomPhase(libelle)
    if (!cle) return null
    const court = clePhase(libelle)
    // Le préfixe « Phase » est retiré des deux côtés : « A Repos » retrouve « Phase A Repos ».
    const direct = idParNom.get(cle) ?? (nomsCourtsAmbigus.has(court) ? undefined : idParNomCourt.get(court))
    if (direct) return direct
    const lettre = /\bphase\s+([a-z0-9]+)\b/.exec(cle)?.[1] ?? (/^[a-z0-9]$/.test(cle) ? cle : '')
    if (lettre) {
      const parLettre = idParLettre.get(lettre)
      if (parLettre) return parLettre
    }
    // Repli mot à mot sur les libellés courts. Même réserve que pour les plans : « Phase 12 » ne doit
    // pas se rattacher à « Phase 1 », et deux phases également proches ne se départagent pas.
    const mots = court.split(' ').filter(Boolean)
    let meilleur: string | null = null
    let meilleurScore = 0
    let exAequo = false
    for (const [nomCourt, id] of idParNomCourt) {
      if (nomsCourtsAmbigus.has(nomCourt)) continue
      const score = alignementMots(mots, nomCourt.split(' '))
      if (score <= 0) continue
      if (score > meilleurScore) { meilleurScore = score; meilleur = id; exAequo = false }
      else if (score === meilleurScore && id !== meilleur) exAequo = true
    }
    return meilleur && !exAequo ? meilleur : null
  }

  /* --- Plans de feux --- */
  const plans: SignalPlan[] = []
  const idParPlan = new Map<string, { id: string; nom: string }>()
  const idsPlans = new Set<string>()
  for (const brut of lirePlansBruts(c.dossier.plans_de_feux, avertissements)) {
    const nom = chaine(brut.nom) || `Plan ${plans.length + 1}`
    const id = identifiantLibre(slug(nom), idsPlans)
    idsPlans.add(id)
    const timings: Record<string, PlanPhaseTiming> = {}
    for (const phaseBrute of tableau(brut.phases).filter(estObjet)) {
      const libelle = chaine(phaseBrute.nom) || chaine(phaseBrute.phase) || chaine(phaseBrute.id)
      const idPhase = resoudrePhase(libelle)
      if (!idPhase) {
        avertissements.push(`Plan « ${nom} » : phase « ${libelle || '?'} » introuvable dans la liste des phases du dossier, réglage ignoré ; la phase garde les durées portées par la liste des phases.`)
        continue
      }
      const { mini, maxi } = bornesDeVert(
        phaseBrute.mini_s, phaseBrute.maxi_s, `Plan « ${nom} », phase « ${libelle} »`, avertissements,
      )
      const phase = phases.find((p) => p.id === idPhase)
      timings[idPhase] = {
        green: mini ?? phase?.green ?? DEFAULT_SIGNAL_TIMING.minGreen,
        minGreen: mini ?? phase?.minGreen ?? DEFAULT_SIGNAL_TIMING.minGreen,
        maxGreen: maxi ?? mini ?? phase?.maxGreen ?? DEFAULT_SIGNAL_TIMING.maxGreen,
      }
    }
    // Une phase déclarée propre à un autre plan reste fermée dans celui-ci : sans cela elle tournerait
    // dans tous les plans et allongerait le cycle des heures creuses d'une phase que le dossier n'y ouvre pas.
    for (const [idPhase, planPropre] of planDeLaPhase) {
      if (planPropre.cle && planPropre.cle !== clePlan(nom) && !timings[idPhase]) {
        const nomPhase = phases.find((ph) => ph.id === idPhase)?.name ?? idPhase
        timings[idPhase] = { green: 0, skipped: true }
        // Le libellé du dossier, jamais la forme normalisée interne : l'exploitant cherche « PF3 » dans
        // son dossier, pas « pf3 ».
        avertissements.push(`Plan « ${nom} » : la phase « ${nomPhase} » n'appartient qu'au plan « ${planPropre.brut} » du dossier, elle est donc fermée dans ce plan.`)
      }
    }
    const plan: SignalPlan = {
      id,
      name: nom,
      cycle: duree(brut.cycle_s, `Plan « ${nom} » : cycle`, avertissements) ?? 0,
      offset: 0,
      phases: timings,
    }
    const periode = chaine(brut.periode) || chaine(brut.description)
    if (periode) plan.period = periode
    plans.push(plan)
    idParPlan.set(clePlan(nom), { id, nom })
  }

  /* --- Calendrier --- */
  const schedule: PlanSchedule[] = []
  const calendrier = c.dossier.calendrier
  if (calendrier !== undefined && calendrier !== null) {
    const entrees: EntreeCalendrier[] = []
    collecterCalendrier(calendrier, null, '', '', entrees)
    if (!entrees.length && plans.length > 1) {
      avertissements.push('Le calendrier n’a pas pu être lu : le premier plan de feux s’appliquera en permanence.')
    }
    const joursDouteux = new Set<string>()
    const replis = new Set<string>()
    const orphelins = new Set<string>()
    for (const e of entrees) {
      const trouve = resoudrePlan(e.plan, idParPlan)
      if (!trouve) {
        avertissements.push(`Calendrier : plan « ${e.plan} » inconnu, plage horaire ignorée.`)
        continue
      }
      // Un rattachement par repli n'est pas une égalité : il se dit, sinon « PF12 » deviendrait « PF1 »
      // en silence.
      if (trouve.repli) replis.add(`« ${e.plan} » → « ${trouve.nom} »`)
      if (e.joursDouteux) joursDouteux.add(e.joursDouteux)
      if (e.horaireOrphelin) orphelins.add(e.horaireOrphelin)
      if (e.horaireSuppose) {
        avertissements.push(`Calendrier : plage horaire absente pour le plan « ${e.plan} », supposé applicable toute la journée.`)
      }
      schedule.push({ planId: trouve.id, fromMin: e.fromMin, toMin: e.toMin, days: e.jours })
    }
    for (const repli of replis) {
      avertissements.push(`Calendrier : ${repli} rattaché par rapprochement de libellés et non par égalité, à vérifier.`)
    }
    for (const texte of orphelins) {
      avertissements.push(`Calendrier : la plage « ${texte} » comporte un nombre impair d'heures ; la dernière n'a pas pu être appariée.`)
    }
    for (const libelle of joursDouteux) {
      avertissements.push(`Calendrier : type de jour « ${libelle} » non reconnu, la plage est appliquée tous les jours.`)
    }
  }

  /* --- Matrices --- */
  const interGreen: InterGreenMatrix = {}
  const amberByGroup: Record<string, number> = {}
  const matrice = lireMatriceInterVerts(c.dossier.matrice_inter_verts, avertissements)
  if (matrice) {
    // Les lignes s'assemblent dans une `Map` : `interGreen[de]` avec une clé venant du fichier
    // remonterait jusqu'à `Object.prototype`, et l'écriture qui suit polluerait toute la session.
    const lignes = new Map<string, Record<string, number>>()
    const reservees = new Set<string>()
    for (const [de, ligne] of matrice.lignes) {
      if (cleReservee(de)) { reservees.add(de); continue }
      for (const [vers, v] of Object.entries(ligne)) {
        if (cleReservee(vers)) { reservees.add(vers); continue }
        const n = nombre(v)
        if (n === null) continue
        if (n < 0) {
          avertissements.push(`Matrice d'inter-verts : temps négatif (${n} s) de ${de} vers ${vers}, case ignorée.`)
          continue
        }
        let colonnes = lignes.get(de)
        if (!colonnes) { colonnes = {}; lignes.set(de, colonnes) }
        colonnes[vers] = n
      }
    }
    for (const [de, colonnes] of lignes) interGreen[de] = colonnes
    // §5 du format : la matrice est annoncée symétrique. On le vérifie sans corriger : une asymétrie est
    // une anomalie de saisie qu'il revient à l'exploitant de trancher.
    const asymetries: string[] = []
    for (const [de, ligne] of Object.entries(interGreen)) {
      for (const vers of Object.keys(ligne)) {
        if (caseDe(interGreen, vers, de) === undefined) asymetries.push(`${de} → ${vers}`)
      }
    }
    if (asymetries.length) {
      avertissements.push(`Matrice d'inter-verts asymétrique : ${asymetries.slice(0, 5).join(', ')}${asymetries.length > 5 ? '…' : ''} sans valeur en sens inverse (valeurs conservées telles quelles).`)
    }
    const inconnus = new Set<string>()
    for (const [de, ligne] of Object.entries(interGreen)) {
      if (!groupesConnus.has(de)) inconnus.add(de)
      for (const vers of Object.keys(ligne)) if (!groupesConnus.has(vers)) inconnus.add(vers)
    }
    if (inconnus.size) {
      avertissements.push(`Matrice d'inter-verts : groupe(s) absent(s) de la liste des groupes (${[...inconnus].join(', ')}).`)
    }
    // `valeur_securite_s` n'est pas repris : le modèle tire les temps de sécurité de la matrice elle-même
    // (§14.3), la colonne de droite ne changerait aucun résultat.
    const jaunes = valeursParGroupe(
      matrice.entete.valeur_jaune_s,
      `Matrice d'inter-verts, valeur de jaune`,
      groupes.filter((g) => g.type === 'vehicule').map((g) => g.id),
      groupesConnus,
      reservees,
      avertissements,
    )
    for (const [g, n] of Object.entries(jaunes)) amberByGroup[g] = n
    if (reservees.size) {
      avertissements.push(`Matrice d'inter-verts : clé(s) ${[...reservees].map((k) => `« ${k} »`).join(', ')} écartée(s), ces noms sont réservés par le langage et ne peuvent pas désigner un groupe.`)
    }
  }
  // §5 du format : aucune phase ne doit réunir deux groupes déclarés incompatibles.
  for (const phase of phases) {
    const ids = phase.groups ?? []
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (caseDe(interGreen, ids[i], ids[j]) !== undefined || caseDe(interGreen, ids[j], ids[i]) !== undefined) {
          avertissements.push(`Phase « ${phase.name} » : les groupes ${ids[i]} et ${ids[j]} sont déclarés incompatibles par la matrice d'inter-verts.`)
        }
      }
    }
  }

  /* --- Contrôleur --- */
  const fonctionnement = lireFonctionnement(c.dossier, phasesBrutes)
  if (fonctionnement.mode === 'actuated' && fonctionnement.cyclique) {
    // Le dossier se contredit : il faut que l'exploitant sache laquelle des deux lectures a été retenue.
    avertissements.push(`Le dossier annonce un fonctionnement cyclique mais décrit ${fonctionnement.motif} : le contrôleur passe en adaptatif ${fonctionnement.skipEmpty ? 'avec escamotage des phases sans demande' : 'sans escamotage, une prolongation de vert n’escamotant pas la phase'}.`)
  }
  const controleur: SignalController = {
    id: controllerId,
    name: c.nom,
    nodeIds,
    mode: fonctionnement.mode,
    offset: 0,
    amber: jauneRepresentatif(amberByGroup),
    allRed: DEFAULT_SIGNAL_TIMING.allRed,
    phases,
    actuated: { skipEmpty: fonctionnement.skipEmpty },
    source: `dossier ${c.dossierId}`,
  }
  if (groupes.length) controleur.groups = groupes
  if (Object.keys(interGreen).length) controleur.interGreen = interGreen
  if (Object.keys(amberByGroup).length) controleur.amberByGroup = amberByGroup
  if (plans.length) controleur.plans = plans
  if (schedule.length) controleur.schedule = schedule

  repartirCycle(controleur, avertissements)

  /*
   * Un mouvement du carrefour qu'AUCUNE phase n'ouvre reste au rouge en permanence : son approche se
   * remplit sans jamais se vider, le bouchon remonte dans le réseau et, en routage dynamique, détourne
   * le trafic sur les voies secondaires. C'est le signe le plus sûr qu'on a chargé le dossier d'un autre
   * carrefour — il faut le dire ici, en nommant les rues, et pas seulement dans les anomalies du plan.
   */
  const ouverts = new Set<MovementKey>()
  for (const phase of controleur.phases) {
    for (const cle of Object.keys(phaseMovements(controleur, phase))) ouverts.add(cle)
  }
  const bloques = mouvements.filter((m) => !ouverts.has(m.mouvement.key))
  if (bloques.length) {
    const rues = [...new Set(bloques.map((m) => network.edges[m.mouvement.from]?.name).filter((n): n is string => !!n))]
    const par = rues.length ? ` L'approche ${rues.join(', ')} restera au rouge en permanence.` : ''
    avertissements.push(`${bloques.length} mouvement(s) du carrefour ne sont ouverts par aucune phase du dossier.${par} Vérifiez que ce dossier est bien celui de ce carrefour ; sinon, complétez ses phases à la main.`)
  }

  const notes = listeDeChaines(c.dossier.notes_extraction)
  if (notes.length) {
    avertissements.push(`Le dossier signale ${notes.length} réserve(s) de lecture (notes d'extraction) : à consulter avant exploitation.`)
  }

  return { controleur, rattaches: groupes.length - nonRattaches.length, nonRattaches }
}

/**
 * Répartit le temps de cycle annoncé par un plan entre ses phases.
 *
 * Un dossier donne, par plan, le cycle et les mini/maxi de chaque phase, mais jamais le vert réellement
 * appliqué : dans un plan à cycle fixe, ce vert est le minimum augmenté de la part du temps qui reste une
 * fois les inter-verts retirés. S'en tenir aux minima ferait tourner le carrefour sur un cycle plus court
 * que la réalité, et lui prêterait donc moins de capacité qu'il n'en a. La part est distribuée au prorata
 * de la marge (maxi − mini) de chaque phase, ce qui donne le gros du temps disponible à la phase de repos.
 */
function repartirCycle(controleur: SignalController, avertissements: string[]): void {
  const toutes = controleur.phases
  if (!toutes.length) return
  for (const plan of controleur.plans ?? []) {
    if (plan.cycle <= 0) continue
    // Une phase fermée par ce plan ne participe ni au cycle ni aux inter-verts : la répartition ne porte
    // que sur les phases réellement ouvertes, et son drapeau de fermeture doit survivre à la répartition.
    const phases = planPhases(controleur, plan)
    if (!phases.length) continue
    let interVerts = 0
    for (let i = 0; i < phases.length; i++) {
      interVerts += phaseTransition(controleur, phases[i], phases[(i + 1) % phases.length]).total
    }
    const timings = phases.map((p) => planPhaseTiming(p, plan))
    const minis = timings.map((t) => t.minGreen)
    const sommeMinis = minis.reduce((a, b) => a + b, 0)
    let disponible = plan.cycle - interVerts - sommeMinis
    if (disponible < -0.5) {
      avertissements.push(`Plan « ${plan.name} » : cycle annoncé de ${plan.cycle} s plus court que la somme des verts minimaux et des inter-verts (${Math.round(interVerts + sommeMinis)} s) ; les minima sont conservés.`)
      disponible = 0
    }
    const verts = [...minis]
    let marges = timings.map((t, i) => Math.max(0, t.maxGreen - minis[i]))
    let sommeMarges = marges.reduce((a, b) => a + b, 0)
    let reste = Math.max(0, disponible)
    // Deux passes : la seconde redistribue ce que les verts maximaux ont refusé à la première.
    for (let passe = 0; passe < 2 && reste > 0.5 && sommeMarges > 0; passe++) {
      const aRepartir = reste
      for (let i = 0; i < verts.length; i++) {
        if (marges[i] <= 0) continue
        const place = Math.max(0, timings[i].maxGreen - verts[i])
        const part = Math.min(place, (aRepartir * marges[i]) / sommeMarges)
        verts[i] += part
        reste -= part
      }
      marges = verts.map((v, i) => Math.max(0, timings[i].maxGreen - v))
      sommeMarges = marges.reduce((a, b) => a + b, 0)
    }
    if (reste > 0.5) {
      avertissements.push(`Plan « ${plan.name} » : ${Math.round(reste)} s du cycle annoncé ne peuvent être attribuées, les verts maximaux étant atteints.`)
    }
    const arrondis = verts.map((v) => Math.round(v))
    // L'écart d'arrondi (au plus une seconde par phase) va à la phase la plus longue, le point de repos.
    const ecart = Math.round(plan.cycle - interVerts) - arrondis.reduce((a, b) => a + b, 0)
    if (ecart !== 0 && Math.abs(ecart) <= phases.length) {
      let plusLongue = 0
      for (let i = 1; i < arrondis.length; i++) if (arrondis[i] > arrondis[plusLongue]) plusLongue = i
      arrondis[plusLongue] = Math.max(0, arrondis[plusLongue] + ecart)
    }
    for (let i = 0; i < phases.length; i++) {
      plan.phases[phases[i].id] = { green: arrondis[i], minGreen: minis[i], maxGreen: timings[i].maxGreen }
    }
  }
}

/** Phases du dossier, remises dans l'ordre du cycle quand `ordre_phases` le donne. */
function ordonnerPhases(dossier: Rec, avertissements: string[]): Rec[] {
  const phases = tableau(dossier.phases).filter(estObjet)
  const ordre = listeDeChaines(dossier.ordre_phases)
  if (!ordre.length || !phases.length) return phases
  const restantes = [...phases]
  const triees: Rec[] = []
  for (const libelle of ordre) {
    const cle = normaliserTexte(libelle)
    const i = restantes.findIndex((p) => {
      const nom = normaliserTexte(chaine(p.nom))
      return nom === cle || nom.startsWith(cle) || cle.startsWith(nom)
    })
    if (i >= 0) triees.push(...restantes.splice(i, 1))
    else avertissements.push(`Ordre des phases : « ${libelle} » ne correspond à aucune phase du dossier.`)
  }
  return [...triees, ...restantes]
}
