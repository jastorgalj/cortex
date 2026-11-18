# Tasks — alias de argumentos, `author` por defecto, `issue: null` en `cortex_write`

> Entorno (todos los grupos): worktree `C:/Users/jastorga/Desarrollo/infra-local/cortex/.worktrees/gh-11`,
> rama `feat/alias-argumentos`. Postgres propio `127.0.0.1:5451` (contenedor `cortex-test-gh-11`).
> Pruebas SIEMPRE con candado, desde la raíz del worktree:
> `MODEL_CACHE_DIR=C:/Users/jastorga/.model-cache/gh-11 bash ../bun-test-locked.sh 5451 [archivos]`.
> Typecheck: `bun run typecheck`. Baseline medida en F0: **193 pass / 0 fail**, typecheck sin errores.
> Nunca el 5433, ni Neon, ni el contenedor `cortex` (:3091). No hay migración: **prohibido** tocar
> `prisma/` (el cambio no toca el esquema; `migrate dev` borraría índices, ver CONTRIBUTING.md).
> Rama: nunca commitear en `main`; los commits los hace `closer`.
> `src/tools/mcp-server.ts` lo toca también #17 (paginación): no reformatear ni mover bloques que no estén
> en estas tareas, para que el rebase de #17 sea de pocas líneas.

## 1. Capa de datos (`issue` en la creación)

- [x] 1.1 `src/db/notes.ts`: `CreateInput.issue` pasa de `issue?: string` (`:104`) a `issue?: string | null`.
  En `createNote` calcular `const issue = input.issue?.trim() ? input.issue : null` y usarlo en
  `tx.note.create` (`:354`, hoy `input.issue ?? null`) y en el `findDuplicates` de `:334`
  (pasar `issue ?? undefined`). Un texto no vacío se guarda **como llegó** (sin `trim`).
- [x] 1.2 No tocar `updateNote` ni su validación de `issue` vacío (`:398`): el escenario vigente
  «issue vacío rechazado» debe seguir verde.

## 2. Módulo de argumentos

- [x] 2.1 Crear `src/tools/args.ts` (sin I/O, sin importar Prisma ni el SDK) con:
  `TOOL_ALIASES` (`cortex_search: {q: ['query','text']}`; `cortex_write` y `cortex_update`:
  `{body_md: ['body','content','markdown']}`); `normalizeToolArgs(tool, args)` que devuelve
  `{ok:true, args}` (canónico con el valor común, alias borrados) o `{ok:false, a, b, canonical}` cuando
  canónico/alias traen valores distintos (`!==`, solo claves con valor `!== undefined`); y
  `resolveAuthor({argument, header, clientName})` que devuelve el primer valor no vacío tras `trim()`
  entre `header`, `clientName` y la cadena `agente`. (`argument` lo evalúa el handler, ver 3.3.)
- [x] 2.2 `normalizeToolArgs` no muta el objeto recibido y devuelve el mismo objeto si la tool no tiene alias
  o ningún alias está presente.

## 3. Servidor MCP (`src/tools/mcp-server.ts`)

- [x] 3.1 En `createSession` (`:414-435`), justo después de `mcpServer.connect(transport)`, envolver
  `transport.onmessage` (no hace falta `await`: la sonda de F0 mostró que ya está asignado): para mensajes
  `method === 'tools/call'` con `params.name` en `TOOL_ALIASES` y `params.arguments` objeto, llamar
  `normalizeToolArgs`; si hay conflicto, responder con
  `transport.send({jsonrpc:'2.0', id: msg.id, result:{content:[{type:'text', text}], isError:true}}, {relatedRequestId: msg.id})`
  y NO llamar al `onmessage` original; si no, delegar con el mensaje reescrito. Texto del error:
  `Error en <tool>: '<a>' y '<b>' llegaron con valores distintos; envía solo '<canónico>'`.
  Todo otro mensaje se delega sin tocar. Prohibido declarar los alias en los schemas de las tools
  (duplican la propiedad en `tools/list` y borran `required`: medido en F0).
- [x] 3.2 Schemas: `author` pasa a `z.string().optional()` en `cortex_write` (`:112`) y `cortex_update`
  (`:215`), con descripción que diga el orden argumento > header `x-cortex-author` > nombre del cliente MCP >
  `agente`. `cortex_write.issue` pasa a `z.string().nullable().optional()` (`:113-116`, igual que
  `cortex_update` `:210-214`). **No** tocar el schema de `cortex_delete` (`:350`): `author` sigue requerido.
- [x] 3.3 Handlers de `cortex_write` (`:128`) y `cortex_update` (`:225`): añadir el 2.º parámetro `extra`.
  Si `author !== undefined`, mantener el chequeo actual (`!author?.trim()` → el error existente, sin caer a otras
  fuentes). Si es `undefined`, `author = resolveAuthor({header: extra?.requestInfo?.headers?.['x-cortex-author'],
  clientName: server.server.getClientVersion()?.name})` (si el header llega como arreglo, usar el primero).
  Pasar `issue` tal cual a `createNote`.
- [x] 3.4 No cambiar los mensajes de error existentes ni el handler de `cortex_delete`.

## 4. Documentación

- [x] 4.1 `README.md`: fila `author` de la tabla de `:43` («Obligatorio en toda escritura» → opcional en
  `cortex_write`/`cortex_update` con la cadena de resolución y la advertencia de que un autor inferido no es un
  autor declarado; `cortex_delete` lo sigue exigiendo); fila `cortex_delete` de `:69` intacta; párrafo corto
  con los alias (`query`/`text`, `body`/`content`/`markdown`) y `issue: null`.
- [x] 4.2 `skills/cortex-mcp/SKILL.md`: misma corrección en la fila `author` (`:58`) y la línea de
  `cortex_write` (`:37`); `cortex_delete` (`:38`, `:85`) sin cambio.
- [x] 4.3 No tocar `CONTRIBUTING.md` ni `package.json` (sin bump de versión).

## 5. Pruebas (coder) — tests primero, sabotaje después

- [x] 5.1 `test/args.test.ts` (unitario, sin BD): `normalizeToolArgs` con cada alias de la tabla; canónico +
  alias iguales; canónico + alias distintos; dos alias distintos entre sí; tool sin alias; argumento
  `undefined`; entrada no mutada. `resolveAuthor` con las cuatro fuentes y con header/cliente `""` y `"   "`.
- [x] 5.2 `test/alias-argumentos.test.ts` (integración, servidor Elysia en proceso, **puerto 13094**,
  mismo patrón de `test/mcp.test.ts`: `Client` + `StreamableHTTPClientTransport`; para el header usar
  `new StreamableHTTPClientTransport(url, {requestInit: {headers: {'x-cortex-author': 'ana'}}})`; el cliente
  de la sesión se nombra con `new Client({name: 'mi-cliente', version: '1'})`). Un test por escenario de los
  deltas `servidor-mcp` y `notas`, con los ids y valores literales de los escenarios. Para `clientInfo.name: ""`
  y el header en blanco usar `fetch` crudo como `test/mcp-sessions.test.ts:70-90`.
- [x] 5.2b El aviso de duplicado (coseno ≥ 0.75) frena notas parecidas: en esa suite, cada nota nueva usa título
  y contenido sin relación con las demás, o `force: true` con `reason` (como piden los escenarios que crean varias
  notas seguidas). Empezar con `TRUNCATE notes CASCADE` como `test/mcp.test.ts:33`, y buscar `ZX-ALIAS-1` solo
  cuando ninguna otra nota lo menciona (patrón del escenario vigente `busqueda:18`).
- [x] 5.3 En esa suite, `tools/list` se compara contra el JSON del `inputSchema`: ninguna propiedad
  `query|text|body|content|markdown`; `required` de `cortex_search` incluye `q`; de `cortex_write` incluye
  `body_md`; `author` fuera de `required` en write y update y dentro en delete; `issue` de `cortex_write`
  admite `string` y `null`.
- [x] 5.4 Confirmar que siguen verdes sin editarlos: `test/mcp.test.ts:204` (`author: ''` rechazado),
  `test/delete.test.ts:109` y `:327`, `test/notes.test.ts:778-789` (`issue: ''` en update).
- [x] 5.5 Sabotaje (revertir cada cambio y ver el test correspondiente en rojo; reportar el nombre del
  test que falló; restaurar y verificar verde): (a) quitar el `normalizeToolArgs` del wrapper → fallan los
  tests de alias; (b) hacer que `resolveAuthor` ignore el header → falla «El header gana al cliente»;
  (c) invertir header y `clientName` → falla «El nombre del cliente gana…»; (d) devolver el primer valor
  en vez de error ante conflicto → falla «q y query distintos»; (e) declarar `query` en el schema de
  `cortex_search` → falla «tools/list no muestra alias»; (f) dejar de descartar el header en blanco
  (aceptar `"   "` como autor) → falla «Un header en blanco se ignora»; (g) hacer opcional `author` en `cortex_delete` → falla
  «Borrado sin author». **Prohibido `git checkout`, `git restore` o `git stash` para deshacer un sabotaje**: el trabajo del coder aún
  no está commiteado y se perdería. Antes de cada sabotaje copiar el archivo a la carpeta scratch
  (`$TMPDIR`), sabotear, y restaurar copiando de vuelta; tras restaurar, `git diff --stat` debe coincidir con el
  de antes del sabotaje.

## 6. QA (cuenta de QA, sin browser; curl + cliente MCP del SDK)

- [x] 6.1 Levantar el servidor **desde el worktree** con un script a archivo (bash, rutas `C:/...`, PID en
  archivo): `PORT=13111`, `DATABASE_URL` = la de `cortex_test` en `127.0.0.1:5451` (la misma que arma
  `../bun-test-locked.sh`; no imprimirla), `MODEL_CACHE_DIR=C:/Users/jastorga/.model-cache/gh-11`, comando
  `bun run src/index.ts`. Esperar `curl http://127.0.0.1:13111/health` con `model_loaded: true`. Nunca :3091
  ni 5433. Declarar el PID en `metadata.procesos` y detenerlo al terminar.
- [x] 6.2 Con `curl` (cabeceras `Content-Type: application/json` y
  `Accept: application/json, text/event-stream`): `initialize` con `clientInfo.name: "qa-cli"`, guardar
  `mcp-session-id`; `tools/call` de `cortex_write` con `content` y sin `author` → la nota queda con
  `author: "qa-cli"`; repetir con `-H 'x-cortex-author: qa-header'` → `author: "qa-header"`; `cortex_search`
  con `query`; `cortex_search` con `q` y `query` distintos → `isError: true`; `cortex_write` con
  `issue: null` y con `issue: ""` → `issue: null`; `cortex_delete` sin `author` → `isError: true`.
- [x] 6.3 Con un script de Node/Bun a archivo que use `Client` + `StreamableHTTPClientTransport` del SDK
  contra `http://127.0.0.1:13111/mcp`: `listTools()` y verificar la ausencia de alias y los `required` de 5.3;
  repetir 6.2 por el cliente. Adjuntar la salida real.
- [x] 6.4 Verificar por `curl http://127.0.0.1:13111/api/notes/<id>` que `author` e `issue` persistidos son
  los esperados y que `GET /health` sigue `ok`.
- [x] 6.5 Limpieza: borrar (con `cortex_delete`, author `qa`, reason `limpieza QA`) las notas que creó la QA
  en `cortex_test`; detener el servidor.

## 7. Cierre (último grupo — única vez que se corre la suite completa)

- [x] 7.1 `bun run typecheck` sin errores.
- [x] 7.2 Suite completa con candado (comando del encabezado): esperado **193 + las pruebas nuevas, 0 fail**.
- [x] 7.3 `openspec validate alias-argumentos-author-issue-null --strict` sin errores ni warnings.
- [x] 7.4 `git status` desde la raíz del worktree: solo `src/db/notes.ts`, `src/tools/args.ts`,
  `src/tools/mcp-server.ts`, `test/args.test.ts`, `test/alias-argumentos.test.ts`, `README.md`,
  `skills/cortex-mcp/SKILL.md` y `openspec/changes/alias-argumentos-author-issue-null/`. Nada en `prisma/`,
  `package.json` ni `bun.lock`.
