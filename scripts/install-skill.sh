#!/usr/bin/env sh
# Instala la skill de Cortex en el árbol de skills de Hermes.
#
# La fuente de verdad es `skills/cortex-mcp-project/` de ESTE repo: si la editás,
# commiteala y volvé a correr este script. Hermes no lee symlinks al escanear
# skills, así que la instalación es una copia, no un enlace.
#
#   ./scripts/install-skill.sh                          # ~/.hermes/skills
#   ./scripts/install-skill.sh --profiles coder,reviewer # también en perfiles worker
set -eu

SKILL=cortex-mcp-project
CATEGORY=software-development
REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SRC="$REPO_DIR/skills/$SKILL"
HERMES_HOME=${HERMES_HOME:-$HOME/.hermes}

[ -f "$SRC/SKILL.md" ] || { echo "no encuentro $SRC/SKILL.md" >&2; exit 1; }

PROFILES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profiles) PROFILES=${2:?falta la lista (ej: coder,reviewer)}; shift 2 ;;
    --profiles=*) PROFILES=${1#*=}; shift ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "opción desconocida: $1" >&2; exit 2 ;;
  esac
done

install_into() {
  dest_root=$1
  dest="$dest_root/$CATEGORY/$SKILL"
  mkdir -p "$(dirname "$dest")"
  rm -rf "$dest"
  cp -R "$SRC" "$dest"
  echo "instalada: $dest ($(wc -l < "$dest/SKILL.md" | tr -d ' ') líneas)"
}

install_into "$HERMES_HOME/skills"

if [ -n "$PROFILES" ]; then
  echo "$PROFILES" | tr ',' '\n' | while read -r p; do
    [ -n "$p" ] || continue
    install_into "$HERMES_HOME/profiles/$p/skills"
  done
fi

echo "listo. Si el menú / del desktop no la ve, corré /reload-skills (usa caché del escaneo)."
