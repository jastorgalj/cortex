#!/usr/bin/env python3
"""Instala las skills de Cortex en Hermes y/o Claude Code (Linux, macOS y Windows).

Este repo trae dos skills, con audiencias distintas:

  cortex-mcp          para el AGENTE QUE USA el MCP: cuándo buscar, qué escribir,
                      deduplicado, base_rev, borrado. Es la que va en el agente.
  cortex-mcp-project  para quien DESARROLLA el servidor: migraciones, tests,
                      entrega por rama + PR, receta contra Neon.

La fuente de verdad es `skills/` de ESTE repo: si editás una skill, commiteá y
volvé a correr este script. La instalación es una copia —el escáner de skills de
Hermes no sigue symlinks— así que los cambios no viajan solos. Si corrés el script
**fuera de un checkout** (solo el `install-skill.py` suelto), baja el árbol completo
de `skills/` desde GitHub antes de instalar.

Destinos:
  Hermes   ~/.hermes/skills/<categoria>/<skill>  (+ profiles/<perfil>/skills/... con --profiles)
  Claude   ~/.claude/skills/<skill>              (+ <repo>/.claude/skills/... con --claude-project)

Ejemplos:
  python scripts/install-skill.py                       # las dos skills, Hermes y Claude
  python scripts/install-skill.py --skills cortex-mcp    # solo la de uso del MCP
  python scripts/install-skill.py --target hermes --profiles coder,reviewer
  py scripts\\install-skill.py                           # Windows

Sin clonar el repo (el script se baja de GitHub y baja el árbol de skills solo):
  curl -fsSL https://raw.githubusercontent.com/jastorgalj/cortex/main/scripts/install-skill.py \
    -o /tmp/install-cortex-skill.py && python /tmp/install-cortex-skill.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

# skill -> categoría en el árbol de Hermes
SKILLS = {
    "cortex-mcp": "productivity",
    "cortex-mcp-project": "software-development",
}
REPO_DIR = Path(__file__).resolve().parent.parent

# Sin checkout, la skill se baja de GitHub (árbol completo, no solo el SKILL.md).
RAW_BASE = "https://raw.githubusercontent.com/jastorgalj/cortex/main"
GIT_TREES_URL = "https://api.github.com/repos/jastorgalj/cortex/git/trees/main?recursive=1"


def _fetch(url: str) -> bytes:
    """GET de una URL pública de GitHub (raw o API)."""
    req = urllib.request.Request(url, headers={"User-Agent": "cortex-install-skill"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read()
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
        raise SystemExit(
            f"no pude bajar {url} desde GitHub: {exc}.\n"
            "revisá tu conexión a internet; si usás la API de GitHub sin token,\n"
            "recordá el límite de 60 requests/hora por IP."
        )


def _skill_files(skill: str) -> list[str]:
    """Enumera los blobs de skills/<skill>/ en la rama main (vía la API de GitHub)."""
    prefix = f"skills/{skill}/"
    tree = json.loads(_fetch(GIT_TREES_URL).decode("utf-8"))
    return [
        item["path"]
        for item in tree.get("tree", [])
        if item.get("type") == "blob" and item["path"].startswith(prefix)
    ]


def source_dir(skill: str) -> Path:
    """Directorio fuente de la skill: el checkout si existe; si no, un temp descargado.

    Sin checkout, `REPO_DIR/skills` no existe: se descarga el árbol completo de la skill
    desde raw.githubusercontent.com (incluye scripts/..., no solo el SKILL.md)."""
    src = REPO_DIR / "skills" / skill
    if (src / "SKILL.md").is_file():
        return src
    files = _skill_files(skill)
    if not files:
        raise SystemExit(f"no encuentro skills/{skill}/ ni en el repo ni en GitHub")
    tmp = Path(tempfile.mkdtemp(prefix="cortex-skill-")) / skill
    for path in files:
        rel = path[len(f"skills/{skill}/"):]
        target = tmp / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(_fetch(f"{RAW_BASE}/{path}"))
    return tmp


def home() -> Path:
    """HOME en Linux/macOS; USERPROFILE en Windows."""
    return Path(os.environ.get("USERPROFILE") or Path.home())


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install(skill: str, dest: Path) -> Path:
    src = source_dir(skill)
    if not (src / "SKILL.md").is_file():
        raise SystemExit(f"no encuentro {src}/SKILL.md")
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dest)
    src_hash, dst_hash = sha(src / "SKILL.md"), sha(dest / "SKILL.md")
    if src_hash != dst_hash:
        raise SystemExit(f"la copia no coincide con el original: {dest}")
    lines = len((dest / "SKILL.md").read_text(encoding="utf-8").splitlines())
    print(f"  ok  {dest}  ({lines} lineas, sha {dst_hash[:8]})")
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Instala las skills de Cortex: uso del MCP y desarrollo del servidor.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--skills", default=",".join(SKILLS),
                    help=f"cuáles instalar, separadas por coma (default: {','.join(SKILLS)})")
    ap.add_argument("--target", default="hermes,claude",
                    help="hermes, claude o ambos separados por coma (default: hermes,claude)")
    ap.add_argument("--profiles", default="",
                    help="perfiles worker de Hermes (ej: coder,reviewer). "
                         "Sin esto, actualiza los perfiles que ya tienen la skill")
    ap.add_argument("--claude-project", default="", metavar="PATH",
                    help="instala además como skills de proyecto en PATH/.claude/skills/")
    ap.add_argument("--hermes-home", default="", help="override de la raíz de Hermes")
    ap.add_argument("--claude-home", default="", help="override de la raíz de Claude")
    args = ap.parse_args()

    wanted = [s.strip() for s in args.skills.split(",") if s.strip()]
    desconocidas = [s for s in wanted if s not in SKILLS]
    if desconocidas:
        print(f"skill desconocida: {', '.join(desconocidas)} (válidas: {', '.join(SKILLS)})",
              file=sys.stderr)
        return 2

    targets = [t.strip().lower() for t in args.target.split(",") if t.strip()]
    hermes_home = Path(args.hermes_home).expanduser() if args.hermes_home else home() / ".hermes"
    claude_home = Path(args.claude_home).expanduser() if args.claude_home else home() / ".claude"
    installed = 0

    for target in targets:
        if target == "hermes":
            if not hermes_home.is_dir():
                print(f"salto Hermes: no existe {hermes_home}")
                continue
            print("Hermes:")
            profiles = [p.strip() for p in args.profiles.split(",") if p.strip()]
            if not profiles:
                # Sin --profiles: actualizar los perfiles que YA tienen la skill, para que
                # una copia vieja en un perfil worker no quede divergiendo en silencio.
                for pdir in sorted((hermes_home / "profiles").glob("*/skills")):
                    if any((pdir / SKILLS[s] / s).is_dir() for s in wanted):
                        profiles.append(pdir.parent.name)
                if profiles:
                    print(f"  perfiles con la skill: {', '.join(profiles)}")
            roots = [("", hermes_home / "skills")]
            for profile in profiles:
                pdir = hermes_home / "profiles" / profile / "skills"
                if not pdir.is_dir():
                    print(f"  salto perfil {profile}: no existe {pdir}")
                    continue
                roots.append((f"perfil {profile}: ", pdir))
            for label, root in roots:
                for skill in wanted:
                    print(f"  {label}" if label else "  ", end="")
                    install(skill, root / SKILLS[skill] / skill)
            installed += 1
        elif target == "claude":
            if not claude_home.is_dir():
                print(f"salto Claude: no existe {claude_home}")
                continue
            print("Claude Code:")
            for skill in wanted:
                install(skill, claude_home / "skills" / skill)
            installed += 1
            if args.claude_project:
                proj = Path(args.claude_project).expanduser().resolve()
                print("Claude Code (proyecto):")
                for skill in wanted:
                    install(skill, proj / ".claude" / "skills" / skill)
        else:
            print(f"target desconocido: {target}", file=sys.stderr)
            return 2

    if not installed:
        print("no se instaló nada: revisá --target o las raíces", file=sys.stderr)
        return 1
    print(f"\nlisto ({installed} destino(s))."
          + (" En Hermes, si el menú / no la ve, corré /reload-skills." if "hermes" in targets else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
