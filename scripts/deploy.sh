#!/usr/bin/env bash
# Déploiement du simulateur sur https://circulation.chaux.me
#
# L'application est entièrement statique : déployer revient à construire le bundle
# et à le recopier dans la racine web servie par Caddy. Aucun service à redémarrer.
#
# Prérequis : dépendances installées (npm install), accès sudo, Caddy déjà configuré
# pour le domaine (bloc « circulation.chaux.me » dans /etc/caddy/Caddyfile).
#
# Usage :
#   ./scripts/deploy.sh              construit puis déploie
#   ./scripts/deploy.sh --check      construit, déploie et rejoue les tests de bout en bout
set -euo pipefail

DOMAINE="circulation.chaux.me"
RACINE="/var/www/${DOMAINE}"
PROJET="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJET"

echo "▸ Vérification des types et tests unitaires"
npm run typecheck
npm test

echo "▸ Construction du bundle de production"
rm -rf dist
npm run build

if [ ! -f dist/index.html ]; then
  echo "✗ dist/index.html absent : construction échouée." >&2
  exit 1
fi

echo "▸ Copie vers ${RACINE}"
sudo mkdir -p "$RACINE"
# --delete retire les anciens bundles hachés ; index.html étant servi en no-cache,
# les visiteurs récupèrent la nouvelle version dès la visite suivante.
sudo rsync -a --delete dist/ "${RACINE}/"
sudo chown -R "$(id -un):caddy" "$RACINE"
sudo chmod -R a+rX "$RACINE"

echo "▸ Contrôle de la configuration Caddy"
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1

# La configuration en service doit rester conforme à la copie versionnée : une dérive
# silencieuse rendrait le déploiement irreproductible sur une autre machine.
REFERENCE="${PROJET}/deploy/circulation.caddy"
if [ -f "$REFERENCE" ]; then
  ACTIF=$(mktemp)
  sudo awk '/^# Simulateur de circulation/,0' /etc/caddy/Caddyfile > "$ACTIF" 2>/dev/null || true
  # La copie versionnée porte un en-tête de commentaires en plus : on compare à partir du bloc lui-même.
  if ! diff -q <(grep -v '^#' "$ACTIF") <(grep -v '^#' "$REFERENCE") >/dev/null 2>&1; then
    echo "  ⚠ /etc/caddy/Caddyfile diffère de deploy/circulation.caddy — mettez la copie versionnée à jour."
  fi
  rm -f "$ACTIF"
fi

echo "▸ Vérification du site en ligne"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "https://${DOMAINE}/")
if [ "$CODE" != "200" ]; then
  echo "✗ https://${DOMAINE}/ répond ${CODE}" >&2
  exit 1
fi
BUNDLE=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' dist/index.html | head -1)
CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "https://${DOMAINE}/${BUNDLE}")
if [ "$CODE" != "200" ]; then
  echo "✗ le bundle ${BUNDLE} répond ${CODE} : déploiement incohérent" >&2
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  echo "▸ Tests de bout en bout sur le site déployé"
  PLAYWRIGHT_BASE_URL="https://${DOMAINE}" npx playwright test
fi

echo "✓ Déployé : https://${DOMAINE}/ (bundle ${BUNDLE})"
