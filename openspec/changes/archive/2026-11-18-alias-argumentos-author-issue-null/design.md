# Design — alias de argumentos, `author` por defecto, `issue: null` en `cortex_write`

## Evidencia medida (sonda en memoria, `@modelcontextprotocol/sdk` 1.32.2, zod 4.6.7)

| Variante | `tools/list` | `{query:"x"}` | `{q, query}` distintos |
|---|---|---|---|
| Hoy (raw shape) | `required:["q"]` | error `expected string, received undefined at q` | ejecuta con `q`, descarta `query` |
| Alias declarado opcional | `q` y `query` visibles, **sin `required`** | llega al handler como `query` | llega con ambos |
| `registerTool` + `z.preprocess(obj)` | **`properties: {}`** | funciona | funciona |
| `validateToolInput` parcheado (API `private` del SDK) | idéntico a hoy | funciona | error propio |
| **Envolver `transport.onmessage`** (API pública de `Transport`) | idéntico a hoy | funciona | respuesta de error propia vía `transport.send` |

La sonda con el transporte HTTP real (`WebStandardStreamableHTTPServerTransport`, igual que
`createSession`) confirmó: el `onmessage` ya está asignado justo después de `mcpServer.connect(transport)`
sin `await` (como lo llama `src/tools/mcp-server.ts:431-432`); `extra.requestInfo.headers` llega en el
handler con las claves en minúscula (`Object.fromEntries(req.headers.entries())`,
`webStandardStreamableHttp.js:481`); `server.server.getClientVersion()?.name` devuelve el `clientInfo.name`
de esa sesión; `clientInfo.name: ""` lo acepta el `initialize` y un `clientInfo` sin `name` lo rechaza.

## Decisiones

**D1 — Mecanismo de alias: envolver `transport.onmessage` en `createSession`.** Después de
`mcpServer.connect(transport)`, reemplazar `transport.onmessage` por una función que, para mensajes
`method === 'tools/call'` cuyo `params.name` esté en la tabla de alias, renombra `params.arguments` y delega
al `onmessage` original. Razón: es la única variante medida que deja `tools/list` intacto y usa solo API
pública. Descartadas: declarar el alias (duplica y borra `required`), `z.preprocess` (borra el schema),
parchear `validateToolInput` (es `private` en `mcp.d.ts:68`; queda como plan B si una versión futura del SDK
cambia `Transport.onmessage`, y los tests de alias lo delatarían).

**D2 — Tabla y módulo.** Nuevo `src/tools/args.ts` (puro, sin I/O): `TOOL_ALIASES`
(`cortex_search: {q: ['query','text']}`, `cortex_write` y `cortex_update`: `{body_md: ['body','content','markdown']}`),
`normalizeToolArgs(toolName, args)` → `{args}` o `{conflict:[a,b]}`, y `resolveAuthor({argument, header, clientName})`.
Razón: `src/tools/mcp-server.ts` es compartido con #17; la lógica nueva va en un archivo propio y el
diff en `mcp-server.ts` se reduce a `createSession` y a los dos schemas.

**D3 — Conflicto.** Para cada nombre canónico: reúne las claves presentes (valor `!== undefined`) entre
canónico y alias. Todas con el mismo valor (`===`) → se conserva el canónico con ese valor y se borran los
alias. Alguna distinta → no se delega al SDK: se responde con
`transport.send({jsonrpc:'2.0', id, result:{content:[{type:'text', text}], isError:true}}, {relatedRequestId: id})`,
texto `Error en <tool>: '<a>' y '<b>' llegaron con valores distintos; envía solo '<canónico>'`.
Verificado con la sonda: el cliente recibe `isError: true` y la tool no corre. Un alias con tipo inválido
(no string) pasa al SDK, que lo rechaza con su mensaje normal sobre el canónico.

**D4 — `author`.** En `cortex_write` y `cortex_update` el schema pasa a `author: z.string().optional()` con
descripción que nombra la cadena de resolución. En el handler: si `author !== undefined` se valida como hoy
(vacío → error `el parámetro 'author' es requerido y no puede estar vacío`, sin caer a las otras fuentes);
si es `undefined` se usa `resolveAuthor` con `extra.requestInfo?.headers['x-cortex-author']` y
`server.server.getClientVersion()?.name`; cada fuente se recorta y se descarta si queda vacía. `registerTools`
ya recibe `server` (`mcp-server.ts:45`), no hace falta tocar `SessionRegistry`. La capa de datos
(`validateCreate` `src/db/notes.ts:170`, `updateNote` `:384`) sigue exigiendo `author` y no cambia.

**D5 — `cortex_delete` sin default** (pregunta P1 de la propuesta; aquí la opción recomendada).
Evidencia: `softDeleteNote` registra quién borró en el `reason` de la revisión final
(`src/db/notes.ts:556`); el requirement vigente «El borrado por tool exige autoría y motivo»
(`openspec/specs/notas/spec.md:113`) ya lo exige; el issue no reporta fallos de `author` en delete (los
8 casos medidos son de `cortex_update`). Con la opción 2 (mismo default) habría que escribir un MODIFIED de
ese requirement y de su escenario «Borrado sin autor o sin motivo rechazado».

**D6 — `issue` en `cortex_write`.** Schema `issue: z.string().nullable().optional()` (igual que
`cortex_update`, `mcp-server.ts:210-214`). `CreateInput.issue` pasa a `string | null` y `createNote`
guarda `NULL` si el valor es `null`, `undefined` o blanco tras recortar; un texto no vacío se guarda como llega
(hoy `src/db/notes.ts:354`: `input.issue ?? null`; hoy `""` se guardaría como `""`, no hay test ni
escenario que lo cubra: se verificó con `grep` en `test/` y en los specs). `findDuplicates`
(`:241-247`) y `classifyCandidate` (`:215`) ya toleran `null`/blanco con `?.trim()`; hay que ajustar solo
los tipos (`issue?: string` → `string | null`) para que compile. **No** se toca `updateNote`: `issue: ""` sigue
siendo error (`:398`, escenario vigente «issue vacío rechazado»).

**D7 — Claves desconocidas** (P2). Sin cambio: el schema descarta en silencio la clave que no es alias
(medido). Un alias que no esté en la tabla seguirá fallando como hoy. Rechazarlas cambiaría el contrato para
cualquier cliente que envíe campos extra.

**D8 — Sin MODIFIED.** Revisados los escenarios vigentes de `servidor-mcp`, `notas` y `busqueda` contra las
reglas nuevas: «Escritura sin autor rechazada» (`notas:18`) habla de `author` **vacío** y sigue verdadero
(D4); «Borrado sin autor o sin motivo rechazado» (`notas:120`) sigue verdadero con D5; «tools/list devuelve
exactamente siete» (`servidor-mcp:94`) no cambia (los alias no son tools); «Ciclo completo por MCP»
(`servidor-mcp:101`) envía `author` explícito; «Un issue en blanco no filtra» (`busqueda:145`) es del
filtro, no de la creación. El nombre del escenario «Escritura sin autor rechazada» queda engañoso (dice
«sin», prueba «vacío»); un MODIFIED no puede renombrarlo, así que el requirement nuevo «Un author enviado vacío
sigue rechazado» lo aclara.

## Riesgos

- **Autoría inferida no es autoría declarada.** `author` pasa a poder valer el nombre del cliente
  (`claude-code`, `mcp-test-client`) o `agente`; luego no se distingue «declarado» de «inferido» sin una
  columna nueva (no se agrega: sería migración y el issue no lo pide). El README lo dice.
- **El header lo pone el cliente.** El servidor no tiene autenticación (`README.md:106`); el header
  `x-cortex-author` no agrega ni quita garantías.
- **Archivo compartido con #17:** `src/tools/mcp-server.ts` (ver `propuesta.md` §3).
- **Dependencia de orden de asignación:** el wrapper de `onmessage` asume que `connect` lo asigna de forma
  síncrona. La sonda lo midió con `connect` sin `await`; un test de integración sobre `createSession` real lo
  protege contra un cambio del SDK.
