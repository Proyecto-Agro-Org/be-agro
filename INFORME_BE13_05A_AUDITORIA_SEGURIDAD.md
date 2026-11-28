# BE13-05A — Auditoría adversarial de la composición

## Método

Revisión de código, 13 vectores automatizados (`test/be13-05a-adversarial.test.js`) con dependencias deliberadamente maliciosas y verificación de mutación de 3 controles (reconciliación A1, resultado del claim, realm de BE-12), todos detectados.

## Hallazgos

| ID | Severidad | Descripción | Evidencia | Corrección | Estado |
| --- | --- | --- | --- | --- | --- |
| C1 | BAJO | El resultado `duplicate` devolvía el mismo objeto `key` que se había entregado al puerto de idempotencia inyectado (alias con una dependencia). Congelado, sin impacto de integridad, pero viola "sin referencias compartidas". | V13 falló antes de la corrección | Copia nueva de la clave en todos los resultados (`idemOut`) | CORREGIDO |
| C2 | BAJO | Revisión de la prueba funcional #14: la aserción "no reconsultar autoridades" contaba un nombre inexistente y era vacía. | Revisión de código | Aserción reemplazada por conteo real de llamadas | CORREGIDO |
| C3 | MEDIO (arquitectónico) | El `SensorRepository` BE-11 no permite resolver por clave técnica ni asociación en un instante; el store Mongo de ingesta no existe. | Contrato BE-11 | Puerto `IngestionIdentityStore` con realm obligatorio; implementación Mongo pendiente | PENDIENTE |
| C4 | MEDIO (futuro) | Claim antes de persistir: si la escritura futura falla tras el claim, un retry legítimo se respondería `duplicate`. | Diseño | Hoy no se persiste; documentado como condición de la etapa de persistencia | PENDIENTE |
| C5 | BAJO | TOCTOU residual: un `accepted` es una instantánea; cambios posteriores no se reflejan. | V11 | Documentado | RESIDUAL |

No se demostraron bypasses CRÍTICOS ni ALTOS.

## Vectores resistidos

Candidate fabricado/clonado/spread/Proxy/prototipo; inyección de ready, trusted event o resultado previo como entrada; omisión de cualquier dependencia o política; realm/tenant/clientId en payload; concurrencia de idempotencia (1 aceptado de 4); colisión de `eventId` con contenido distinto (payload o reloj declarado); puerto de idempotencia mentiroso (fingerprint malformado, campos extra); BE-12 malicioso (evento alterado, otra revisión, otro instante/clock, otro realm, rechazo con código desconocido, throw con getter hostil, timeout); política maliciosa (persistedAt sustituido); drift tras revalidación (dispositivo inactivo antes de BE-12); resolución cruzada de clientes (dos dueños → `overlapping-association`) y de realms (store que filtra filas). Detalle: `MATRIZ_BE13_05A_VECTORES.md`.

## Trust boundaries (fase 27)

- TypeScript no es frontera de seguridad: todos los vectores usan objetos JavaScript arbitrarios.
- WeakSet/WeakMap = procedencia dentro del proceso.
- Políticas y autoridades inyectables no son autenticación; un caller del proceso puede inyectar dobles permisivos.
- El trust boundary productivo será el bootstrap/composition root que elija adapters revisados; hoy no existe.

## Validaciones

`npm.cmd ci --offline` OK · typecheck OK · build OK · `npm test` **664/664** · HTTP 13/13 · `git diff --check` OK.

## Recomendación

Listo para revisión local. No publicar hasta revisar C3/C4 y aceptar explícitamente el contrato de idempotencia (clave por campo, fingerprint técnico).
