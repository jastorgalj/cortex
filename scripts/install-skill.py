#!/usr/bin/env python3
"""Instala la skill de Cortex en Hermes y/o Claude Code (Linux, macOS y Windows).

La fuente de verdad es `skills/cortex-mcp-project/` de ESTE repo: si la editás,
commiteá y volvé a correr este script. La instalación es una copia —el escáner de
skills de Hermes no sigue symlinks— así que los cambios no viajan solos.

Destinos:
  Hermes   ~/.hermes/skills/software-development/cortex-mcp-project
           (+ ~/.hermes/profiles/<perfil>/skills/... con --profiles)
  Claude   ~/.claude/skills/cortex-mcp-project
           (+ <repo>/.claude/skills/... con --claude-project)

Ejemplos:
  python scripts/install-skill.py                      # Hermes y Claude, si existen
  python scripts/install-skill.py --target hermes      # solo Hermes
  python scripts/install-skill.py --profiles coder,reviewer
  python scripts/install-skill.py --claude-project .   # skill de proyecto en el repo
  py scripts\\install-skill.py                          # Windows
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
from pathlib import Path

SKILL = "cortex-mcp-project"
CATEGORY = "software-development"
REPO_DIR = Path(__file__).resolve().parent.parent
SRC = REPO_DIR / "skills" / SKILL


def home() -> Path:
    """HOME en Linux/macOS; USERPROFILE en Windows."""
    return Path(os.environ.get("USERPROFILE") or Path.home())


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install(dest: Path) -> Path:
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SRC, dest)
    src_hash, dst_hash = sha(SRC / "SKILL.md"), sha(dest / "SKILL.md")
    if src_hash != dst_hash:
        raise SystemExit(f"la copia no coincide con el original: {dest}")
    lines = len((dest / "SKILL.md").read_text(encoding="utf-8").splitlines())
    print(f"  ok  {dest}  ({lines} lineas, sha {dst_hash[:8]})")
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Instala la skill de Cortex en Hermes y/o Claude Code.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--target",
        default="hermes,claude",
        help="hermes, claude o ambos separados por coma (default: hermes,claude)",
    )
    ap.add_argument("--profiles", default="", help="perfiles worker de Hermes (ej: coder,reviewer)")
    ap.add_argument("--claude-project", default="", metavar="PATH",
                    help="instala además como skill de proyecto en PATH/.claude/skills/")
    ap.add_argument("--hermes-home", default="", help="override de la raíz de Hermes")
    ap.add_argument("--claude-home", default="", help="override de la raíz de Claude")
    args = ap.parse_args()

    if not (SRC / "SKILL.md").is_file():
        print(f"no encuentro {SRC}", file=sys.stderr)
        return 1

    targets = [t.strip().lower() for t in args.target.split(",") if t.strip()]
    hermes_home = Path(args.hermes_home).expanduser() if args.hermes_home else home() / ".hermes"
    claude_home = Path(args.claude_home).expanduser() if args.claude_home else home() / ".claude"
    installed = 0
    skipped = 0

    for target in targets:
        if target == "hermes":
            if not hermes_home.is_dir():
                print(f"salto Hermes: no existe {hermes_home}")
                skipped += 1
                continue
            print("Hermes:")
            install(hermes_home / "skills" / CATEGORY / SKILL)
            installed += 1
            for profile in [p.strip() for p in args.profiles.split(",") if p.strip()]:
                pdir = hermes_home / "profiles" / profile / "skills"
                if not pdir.is_dir():
                    print(f"  salto perfil {profile}: no existe {pdir}")
                    continue
                install(pdir / CATEGORY / SKILL)
        elif target == "claude":
            if not claude_home.is_dir():
                print(f"salto Claude: no existe {claude_home}")
                skipped += 1
                continue
            print("Claude Code:")
            install(claude_home / "skills" / SKILL)
            installed += 1
            if args.claude_project:
                proj = Path(args.claude_project).expanduser().resolve()
                print("Claude Code (proyecto):")
                install(proj / ".claude" / "skills" / SKILL)
        else:
            print(f"target desconocido: {target}", file=sys.stderr)
            return 2

    if not installed:
        print("no se instaló nada: revisá --target o las raíces", file=sys.stderr)
        return 1
    print(f"\nlisto ({installed} destino(s))."
          + (" En Hermes, si el menú / no la ve, corré /reload-skills." if "hermes" in targets else ""))
    return 0 if not skipped or installed else 1


if __name__ == "__main__":
    raise SystemExit(main())
