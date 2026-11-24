# BE13-10B — Auditoría de seguridad de la gobernanza de leases

## Alcance

Lease persistido, adquisición, liberación, recuperación, fencing, validator y migración, audit y readiness. Evidencia:

- 34 pruebas offline;
- campaña Mongo real 28/28 × 2;
- 6 mutantes detectados;
- regresión BE13-08 y BE13-09.

## Estado de S7: **CLOSED**

Los ocho criterios exigidos se demostraron:

1. protección del dueño activo;
2. expiración fail-closed;
3. recuperación autorizada;
4. CAS;
5. fencing final;
6. ausencia de escritura stale;
7. campaña Mongo;
8. mutantes.

Detalle en `ADR_BE13_10B_S7_CLOSURE.md`.

## Modelo de confianza

- La propiedad la determina el principal que devuelve la autoridad de operadores. El `token` no autentica: ordena las adquisiciones y hace de fence.
- El tiempo lo determina la `OperationsTimeAuthority` inyectada. La expiración la decide la `ReplayLeasePolicy` inyectada. Ninguna de las dos está decidida para Production, y sus placeholders bloquean.
- El bootstrap sigue siendo la frontera de confianza: código en proceso con acceso directo al store puede saltarse el servicio.

## Hallazgos

| ID | Severidad | Estado |
| --- | --- | --- |
| S7 Liberación indebida de lease durante un replay | MEDIO | **CERRADO** (BE13-10B) |
| H1 `version` inválida como fencing token | MEDIO | CORREGIDO (token dedicado) |
| H2 El replay sin lease de BE13-08 podía escribir sobre una entrada descartada | MEDIO | CORREGIDO (fence `RETRYABLE`) |
| H3 Un adaptador que ignora el fence lo anula en silencio | MEDIO | CORREGIDO (`replayFencing: 'atomic'` obligatorio) |
| H4 Un replay que perdió el lease se informaba `done` | BAJO | CORREGIDO |
| H5 La campaña BE13-08 no reflejaba `version` (BE13-09) | BAJO | CORREGIDO |
| R1 Bypass en proceso del store | INFORMATIVO | ACEPTADO / documentado |
| R2 Lease huérfano sin política `EXPIRED` | BAJO | ACEPTADO: depende de una decisión humana; sin worker |

Sin hallazgos ALTOS ni CRÍTICOS abiertos.

## Escaneo de secretos (manual)

Se buscaron en el diff contra `dev` las siguientes cadenas, sin imprimir valores:

- `password`, `passwd`, `secret`, `token=`, `Bearer`;
- `mongodb://` con credenciales, `mongodb+srv`, `mongodb.net`;
- `x-emqx-key`, `AKIA`, `BEGIN … PRIVATE KEY`.

Solo aparecen:

- tokens sintéticos de prueba (`tok-*`);
- el término "token" con el sentido de *fencing token*;
- literales que el validator **rechaza** (`x-emqx-key` en pruebas preexistentes).

No hay ningún secreto ni cadena de conexión con credenciales.

## Runtime

- `app.ts` sin cambios.
- Sin endpoints de replay, release, recover, discard ni audit.
- Sin worker, cron, watcher ni expiración automática.
- HTTP 13/13 equivalente.
- `productionReady` es el literal `false`.
