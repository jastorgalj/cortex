# Proposal

## Why

El conocimiento del equipo vivió hasta ahora en un repo git (`novara-knowledge`) sincronizado
por cada máquina y escrito por herramientas que hacían git automático (`bitacora note --team`,
pulls en session-start). En uso real eso produjo choques con el flujo git del equipo: ramas de
learnings en repos de código, pushes directos a main, repos clonados por máquina que quedaban
atrás, y conocimiento que un worker no veía porque su worktree estaba en otra rama. El equipo
ya probó variantes del git de conocimiento y la fricción persiste: la sincronización
distribuida es el problema, no el formato.

Este proyecto la elimina: **un** servidor central con **una** base de datos, consumido por MCP
desde los agentes de los 5-10 devs. Nadie sincroniza nada; escribir es una llamada y leer es
una búsqueda. La decisión de arquitectura (DB central sola, sin git) la tomó el usuario en el
gate del 2026-11-04.

## What Changes

Proyecto nuevo (greenfield): servidor MCP de conocimiento con

- **Notas** como unidad de conocimiento: markdown + título, tags, autor declarado, referencia
  opcional a issue. CRUD completo con borrado lógico.
- **Revisiones**: toda actualización guarda la versión anterior en una tabla append-only
  (autor, fecha, motivo). Es el reemplazo del historial que daba git.
- **Búsqueda híbrida**: léxica (full-text de Postgres en español, insensible a tildes) +
  semántica (embeddings ONNX locales en el servidor, pgvector), fusionadas. Es la operación
  principal del sistema.
- **Detección de duplicados al escribir**: una nota nueva con similitud semántica ≥ 0.55 contra
  una existente no se crea a ciegas — el servidor devuelve las similares para que el agente
  decida actualizar la existente o forzar la creación.
- **Seis tools MCP** sobre HTTP (transporte streamable del SDK oficial): `kb_search`,
  `kb_read`, `kb_write`, `kb_update`, `kb_list`, `kb_history`.
- **Vista web de solo lectura** (lista + render de nota) para consulta humana directa sin
  agente.
- **API REST de solo lectura** (`GET /api/search`, `GET /api/notes/:id`) para scripts, CI y
  debugging sin cliente MCP; la escritura existe únicamente por MCP, donde viven validación,
  revisiones y deduplicación.
- **Importación inicial** del contenido vigente de `novara-knowledge` (carpeta `sistemas/` y
  learnings no obsoletos) como notas con autor y fecha de origen.
- **Empaquetado**: Dockerfile del server + docker-compose (server + Postgres/pgvector para
  dev); en deploy la DB es externa vía `DATABASE_URL` — Neon primero y cualquier otro Postgres
  después (migración = `pg_dump | pg_restore` + cambiar la URL). El host
  del server se decide después (fuera de alcance).

## Fuera de alcance

- Autenticación y autorización: el servidor se despliega en red interna/VPN; la autoría es
  declarativa. Decisión del usuario, revisable si el equipo crece.
- El host de deploy concreto y su DNS/proxy: el entregable es la imagen + compose.
- UI web de escritura: los humanos escriben a través de su agente; la vista web es solo
  lectura en v1.
- Sincronización con git en cualquier dirección: eliminada por decisión de arquitectura.
- Integración con bitacora: bitacora quedó como herramienta de grafo de código (change
  `bitacora-solo-grafo` del fork) y no conoce este servidor.

## Capabilities

### New Capabilities

- `notas`: ciclo de vida de una nota de conocimiento — crear con detección de duplicados,
  leer, actualizar con revisión, listar, borrar lógico, historial; e importación inicial desde
  el repo `novara-knowledge`.
- `busqueda`: búsqueda híbrida léxica + semántica con umbrales definidos y filtros por tag.
- `servidor-mcp`: el contrato del servidor — las seis tools MCP sobre HTTP streamable, la
  vista web de solo lectura, el healthcheck y el empaquetado Docker.

## Impact

- Repo nuevo `novara-knowledge-mcp` (TypeScript + Bun + Elysia + PostgreSQL 16/pgvector +
  @huggingface/transformers ONNX + @modelcontextprotocol/sdk).
- El repo git `novara-knowledge` queda congelado como archivo histórico tras la importación
  (no se borra; deja de recibir escrituras).
- Los agentes del equipo agregan un servidor MCP remoto a su configuración; los que solo
  hablan stdio usan un bridge local (mcp-proxy).
