# BE13-07A — Auditoría de seguridad

## Método

Revisión de código, 9 vectores adversariales offline sobre el root, 3 pruebas del guard multi-nodo y campaña multi-nodo real (2 ejecuciones finales). Los tipos de TypeScript no se consideraron frontera de seguridad.

## Hallazgos

| ID | Severidad | Descripción | Evidencia | Acción | Estado |
| --- | --- | --- | --- | --- | --- |
| R1 | MEDIO (diseño) | Un commit ambiguo (`UnknownTransactionCommitResult`) llega al llamador como `persistence-unavailable` aunque la medición quede confirmada. | MN14 REAL; datos +1/+1; retry → `duplicate` | Comportamiento fail-closed conservado; reintento idempotente documentado como requisito del runtime | PENDIENTE (política de reintentos) |
| H1 | BAJO (harness) | tmpfs de 512 MB → `OutOfDiskSpace` al crear índices. | Primera ejecución | tmpfs 1024 MB | CORREGIDO |
| H2 | BAJO (harness) | El clasificador marcaba MN14 como no reproducido pese a evidencia real. | Evidencia de eventos | Clasificación según la etiqueta recibida | CORREGIDO |
| H3 | BAJO (harness) | El pre-chequeo de puertos contaba sockets `TIME_WAIT`. | `Get-NetTCPConnection` | Solo `Listen` | CORREGIDO |
| H4 | BAJO (pruebas) | La auditoría de imports de `test-support` era demasiado amplia (coincidía con un comentario). | V1 | Detección de imports reales (estáticos, dinámicos, `require`) | CORREGIDO |

No se encontraron vulnerabilidades CRÍTICAS ni ALTAS en el código de producción.

## Vectores (detalle en `MATRIZ_BE13_07A_VECTORES.md`)

| Vector | Resultado |
| --- | --- |
| Autoridad "productiva" falsa | Readiness `INJECTED_UNVERIFIED`; nunca "aprobada" |
| Import accidental de un fake | Ningún módulo de `src/` importa `test-support`; placeholders solo exportan factories bloqueantes |
| Realm suplantado (payload, topic, campos) | Ignorado; realm solo desde la authority, leída una vez |
| Bypass del root / construcción directa del composer | **Posible dentro del proceso** (exports de nivel inferior); las capas inferiores siguen fail-closed (documento crudo y candidate clonado → `invalid-candidate`) |
| Modo permisivo por variables de entorno | Inexistente; probado con variables hostiles |
| Verifier faltante | `TypeError` |
| Política malformada o mentirosa | `invalid-authority-response` / `contradictory-authority` |
| Datos cross-realm del store | `realm-mismatch` |
| Candidates o readies clonados | Rechazados (registros de procedencia) |
| Evidencia de procedencia de otro documento | `unverified-provenance` |
| TOCTOU | Un `accepted` es una instantánea; cambios posteriores no se reflejan; retry → `duplicate` |

## Qué puede y qué no puede protegerse dentro del mismo proceso

- **Puede:** errores de composición accidentales (dependencias faltantes, placeholders olvidados, fakes importados por error), datos malformados o cross-realm de stores y autoridades, objetos clonados o fabricados que no pasaron por el mapper o el gate, realm tomado del payload.
- **No puede:** código hostil con ejecución en el backend. Puede instanciar la composición de nivel inferior, inyectar dobles que aprueben todo o crear su propia authority de procedencia. Los registros WeakSet/WeakMap son procedencia en proceso, no autenticación. El trust boundary real es el **bootstrap**: qué código se despliega y qué adapters revisados se inyectan.

## Secretos y dependencias

Sin URIs reales, contraseñas, tokens, `x-emqx-key` ni connection strings en el diff (búsqueda realizada; solo hay strings sintéticos en las pruebas). Sin dependencias nuevas: se usa el driver incluido en `mongoose`.

## Validaciones

`npm.cmd ci --offline` OK · typecheck OK · build OK · `npm test` **721/721** · HTTP 13/13 · `git diff --check` OK · multi-nodo 22 PASS / 2 NO VERIFICABLE / 0 FAIL ×2.
