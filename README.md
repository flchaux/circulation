# Circulation — simulateur de trafic et de signalisation

Application web pour étudier les conséquences d'un changement de signalisation dans une commune française :
plans de feux, stops, sens uniques, zones 30, giratoires, fermetures de voies.
Tout s'exécute dans le navigateur, sans serveur.

Code source : <https://github.com/flchaux/circulation>

## Démarrer

```bash
npm install
npm run dev        # http://localhost:5173
```

Autres commandes :

```bash
npm run build      # vérification des types puis build de production dans dist/
npm run test       # tests unitaires (Vitest)
npm run e2e        # tests de bout en bout (Playwright, nécessite un build préalable)
npm run extract-city -- 42323 veauche   # pré-extraire une commune dans public/demo/
```

## Utilisation

1. **Ville** : cherchez une commune par son nom ou son code postal, ou ouvrez une démonstration embarquée.
   Le réseau routier est extrait d'OpenStreetMap et découpé au contour administratif de la commune.
2. **Réseau** : déplacez les nœuds à la souris, fusionnez-les en les déposant l'un sur l'autre, modifiez le sens,
   la vitesse, le nombre de voies, fermez un tronçon, changez le type de carrefour, interdisez des mouvements.
3. **Feux** : réglez les phases mouvement par mouvement, les durées de vert, l'orange, le rouge intégral, le décalage
   entre carrefours pour créer une onde verte, ou passez un carrefour en mode adaptatif.
4. **Trafic** : réglez les débits entrants, la matrice origine-destination, le trafic interne, ou importez un CSV
   de comptages. Lancez la simulation depuis la barre supérieure.
5. **Résultats** : débit, retard, vitesse, files et saturation par tronçon, par sortie et par carrefour.
6. **Comparer** : figez un scénario de référence, modifiez la signalisation, relancez, et lisez les écarts.

Vos modifications sont enregistrées automatiquement dans le navigateur. Le bouton d'export produit un fichier JSON
autonome qui contient le réseau, les feux, la demande et les résultats : il se recharge à l'identique.

## Déploiement

Le site public est <https://circulation.chaux.me>. L'application étant entièrement statique,
déployer revient à construire le bundle et à le recopier dans la racine servie par Caddy.

```bash
npm run deploy            # types, tests, build, copie, vérification en ligne
npm run deploy -- --check # idem, puis rejoue les tests de bout en bout sur le site déployé
```

Le bloc de configuration Caddy en service est versionné dans `deploy/circulation.caddy`.
Sur une machine neuve, ajoutez-le à la fin de `/etc/caddy/Caddyfile`, puis rechargez Caddy :
le certificat est obtenu automatiquement dès lors que le DNS du domaine pointe sur la machine.
`npm run deploy` signale toute divergence entre la configuration en service et cette copie.

Réglages en place sur le serveur :

- Caddy sert `/var/www/circulation.chaux.me` et obtient le certificat Let's Encrypt automatiquement.
  Le bloc de configuration se trouve à la fin de `/etc/caddy/Caddyfile`.
- Le HTTP est redirigé vers le HTTPS en 308.
- Les bundles de `/assets/` portent un hash de contenu et sont mis en cache pour un an ;
  `index.html` est servi en `no-cache` afin qu'une nouvelle version soit prise en compte à la visite suivante.
- Les réponses sont compressées en zstd ou gzip selon le navigateur.
- Les fichiers de correspondance de sources (`.map`) sont publiés délibérément : le code n'a rien de
  confidentiel et ils permettent de déboguer un problème signalé par un utilisateur. Un navigateur ne les
  télécharge que si les outils de développement sont ouverts. Pour cesser de les publier, passez
  `build.sourcemap` à `false` dans `vite.config.ts` et redéployez.
- L'application n'est jamais servie en clair : `Strict-Transport-Security` est posé sans `includeSubDomains`,
  afin de n'engager que ce sous-domaine.

Pour rejouer les tests de bout en bout contre n'importe quelle instance :

```bash
PLAYWRIGHT_BASE_URL=https://circulation.chaux.me npx playwright test
```

## Données

Réseau routier : © les contributeurs OpenStreetMap, sous licence ODbL, via l'API Overpass.
Communes et contours : geo.api.gouv.fr (Etalab). Fond de carte : tuiles OpenStreetMap.

Les résultats sont indicatifs : le modèle n'est pas calibré sur des comptages réels tant que vous n'en importez pas.

## Documentation technique

`docs/ARCHITECTURE.md` décrit le modèle de données, le moteur de simulation, l'import OSM et les contrats entre modules.
