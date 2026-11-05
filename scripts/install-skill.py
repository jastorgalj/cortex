#!/usr/bin/env python3
"""Instala las skills de Cortex en Hermes y/o Claude Code (Linux, macOS y Windows).

Este repo trae dos skills, con audiencias distintas:

  cortex-mcp          para el AGENTE QUE USA el MCP: cuándo buscar, qué escribir,
                      deduplicado, base_rev, borrado. Es la que va en el agente.
  cortex-mcp-project  para quien DESARROLLA el servidor: migraciones, tests,
                      entrega por rama + PR, receta contra Neon.

La fuente de verdad es `skills/` de ESTE repo: si editás una skill, commiteá y
volvé a correr este script. La instalación es una copia —el escáner de skills de
Hermes no sigue symlinks— así que los cambios no viajan solos.

Destinos:
  Hermes   ~/.hermes/skills/<categoria>/<skill>  (+ profiles/<perfil>/skills/... con --profiles)
  Claude   ~/.claude/skills/<skill>              (+ <repo>/.claude/skills/... con --claude-project)

Ejemplos:
  python scripts/install-skill.py                       # las dos skills, Hermes y Claude
  python scripts/install-skill.py --skills cortex-mcp    # solo la de uso del MCP
  python scripts/install-skill.py --target hermes --profiles coder,reviewer
  py scripts\\install-skill.py                           # Windows
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
from pathlib import Path

# skill -> categoría en el árbol de Hermes
SKILLS = {
    "cortex-mcp": "productivity",
    "cortex-mcp-project": "software-development",
}
REPO_DIR = Path(__file__).resolve().parent.parent


def home() -> Path:
    """HOME en Linux/macOS; USERPROFILE en Windows."""
    return Path(os.environ.get("USERPROFILE") or Path.home())


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install(skill: str, dest: Path) -> Path:
    src = REPO_DIR / "skills" / skill
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
    ap.add_argument("--profiles", default="", help="perfiles worker de Hermes (ej: coder,reviewer)")
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
            roots = [("", hermes_home / "skills")]
            for profile in [p.strip() for p in args.profiles.split(",") if p.strip()]:
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
