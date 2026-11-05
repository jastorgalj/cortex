## 1. Renombre de tools y de producto

- [x] 1.1 `src/tools/mcp-server.ts`: renombrar las seis tools registradas a `cortex_search`, `cortex_read`, `cortex_write`, `cortex_update`, `cortex_list`, `cortex_history`; cambiar `name` del `McpServer` a `cortex` y `version` a `0.2.0`. Reescribir TODOS los textos que nombran una tool: prefijos `Error en kb_xxx`, la pista de `similar_exists` («usa kb_update sobre el id candidato»), el mensaje de conflicto («Lee la nota de nuevo con kb_read») y las descripciones de cada tool. No dejar alias `kb_*` (design, Decisión 1: un alias rompería «exactamente siete» y mostraría dos nombres al agente).
- [x] 1.2 Identidad en el resto del código: `src/web/views.ts` (el `<title>` de `layout` pasa de «Novara KB» a «Cortex» y el encabezado del listado de «Knowledge Base» a «Cortex»), prefijo de logs `[knowledge-mcp]` → `[cortex]` en `src/index.ts`, comentarios que citan `kb_search`/`kb_update` en `src/db/search.ts` y `src/db/notes.ts`, y `package.json` (`name: "cortex"`, `version: "0.2.0"`). NO renombrar `~/.model-cache/knowledge-mcp` (`src/db/embeddings.ts`), ni las bases de datos, ni el servicio del compose, ni la carpeta del repo: renombrar el cache obliga a re-descargar ~420 MB del modelo sin beneficio visible (design, Decisión 4).
- [x] 1.3 Tests existentes a los nombres nuevos: `test/mcp.test.ts` (la lista esperada de tools pasa a las seis `cortex_*` ordenadas, y cada `name: 'kb_...'` de las llamadas) y `test/api.test.ts` (línea 43 y los títulos de `describe`). En este grupo la lista esperada tiene SEIS tools; el grupo 2 la sube a siete.
- [x] 1.4 `README.md`: título «Cortex», diagrama y tabla de tools con los nombres `cortex_*`. La tabla se completa con `cortex_delete` en el grupo 3.
- [x] 1.5 Verificación del grupo (solo lo que este grupo toca):
  - `bun run typecheck` sale 0.
  - `bun test test/mcp.test.ts test/api.test.ts` sale 0.
  - `grep -rnE "kb_" src test README.md package.json Dockerfile docker-compose.yml bunfig.toml prisma` no devuelve ninguna línea. El patrón es la cadena `kb_` sin comillas, así que cubre comillas simples, dobles y backticks. Si devuelve alguna línea, corregirla en el código; no ajustar el grep para esconderla.
  - `grep -rniE "Novara KB|Knowledge Base" src package.json` no devuelve ninguna línea (el README se revisa a ojo en 1.4: su prosa puede decir «base de conocimiento» legítimamente).

## 2. Tool `cortex_delete`

- [x] 2.1 `src/db/notes.ts`: cambiar `softDeleteNote` para que reciba `author` y `reason` además del `id`, y que en UNA transacción (a) inserte en `note_revisions` una revisión con la versión vigente de la nota (título, cuerpo, tags), el autor del borrado y el motivo, usando el número de revisión vigente de la nota (clave `(note_id, rev)`: no puede repetir uno existente) y (b) marque `deleted_at`. Una nota inexistente o ya borrada SIGUE lanzando `NotFoundError` con el id en el mensaje y NO crea revisión. Dentro de la transacción no se llama a `embed()` (la transacción interactiva tiene límite de 5 s; el borrado no necesita embedding). No hay migración de Prisma: `note_revisions` ya tiene `author` y `reason`.
- [x] 2.2 `src/tools/mcp-server.ts`: registrar `cortex_delete` con parámetros `id`, `author` y `reason` (los tres `z.string()` requeridos y validados no vacíos, igual que `author` en `cortex_update`). Error descriptivo por cada parámetro vacío con el patrón `Error en cortex_delete: el parámetro 'X' es requerido y no puede estar vacío`. `NotFoundError` responde `Error en cortex_delete: ...` con el id. Éxito: responde el id y `deleted_at`.
- [x] 2.3 Tests nuevos en `test/mcp.test.ts` (o un archivo `test/delete.test.ts` si queda más claro), uno por cada escenario del spec `notas` («Borrado sin autor o sin motivo rechazado» con las dos variantes, «El borrado deja rastro en el historial» con los 3 números de revisión y el autor y motivo de la última, «Borrar una nota inexistente o ya borrada» con las dos variantes) y los de `servidor-mcp` («tools/list devuelve exactamente siete» incluyendo que ningún nombre empiece con `kb_`, «Ciclo completo por MCP con borrado», «Los mensajes de error usan los nombres nuevos»). Aserciones incondicionales: nada de `try/catch` que absorba el fallo. El test de `tools/list` pasa de seis a siete.
- [x] 2.4 Tests de identidad: `serverInfo.name === 'cortex'` y `serverInfo.version === '0.2.0'` en el `initialize`; `<title>` de `GET /` y de `GET /notes/<id>` contiene «Cortex» y no «Novara KB». Para las rutas web usa el patrón de los tests existentes de la vista.
- [x] 2.5 Prueba de que los tests pueden fallar, POR CADA ruta de borrado que 2.3 dice cubrir: romper a propósito (p. ej. no insertar la revisión; aceptar `author` vacío; aceptar `reason` vacío; no lanzar `NotFoundError` en nota ya borrada), confirmar que el test correspondiente falla, revertir y dejar en el handoff una línea por ruta con el test que falló. Sabotear solo una ruta no demuestra las demás.
- [x] 2.6 Verificación del grupo (solo lo afectado): `bun run typecheck` sale 0 y `bun test test/mcp.test.ts test/api.test.ts` más el archivo nuevo si lo hay, salen 0.

## 3. Validación de cierre

- [x] 3.1 `README.md`: tabla de tools con las SIETE (`cortex_delete`: «Borrar una nota (borrado lógico). Exige `author` y `reason`; queda en el historial») y el diagrama que dice «6 tools» pasa a siete.
- [x] 3.2 Compuertas completas, una sola vez, con la salida a un archivo del scratch y leyendo solo el resumen: `bun run typecheck` y `bun test` (suite completa; corre contra la base `cortex_test` del compose, nunca contra `cortex` ni contra Neon). Todo rojo se compara contra la base `ca7aa73` antes de declararlo preexistente.
- [x] 3.3 `openspec validate cortex-renombre-y-borrado` sale 0 sin errores.
- [x] 3.4 Barrido final: `grep -rnE "kb_" src test README.md package.json` sigue sin devolver nada.

## Workflow follow-up

Pasos que ninguna card ejecuta (los hace el orquestador con el usuario después del cierre):

- Reiniciar los servidores de prueba (puertos 3091 y 3092) desde este worktree: hoy sirven el código anterior desde el worktree `v1`.
- Quitar y volver a registrar el servidor `cortex` en Hermes (`hermes mcp remove cortex` y `hermes mcp add cortex --url http://localhost:3091/mcp`) para refrescar el cache de tools; abrir sesión nueva o `/reload-mcp`.
- Borrar de Neon la nota de prueba que cree el flujo de validación, si el closer la deja.
- Renombrar la carpeta del repo y crear el remoto (pendiente de la URL del usuario).
- Skill de Hermes que enseñe a los agentes cuándo consultar y cuándo escribir en Cortex (siguiente entregable).
