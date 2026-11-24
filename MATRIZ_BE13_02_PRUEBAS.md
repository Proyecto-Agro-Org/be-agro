# BE13-02 — Matriz de pruebas

| Cobertura | Resultado esperado | Estado |
|---|---|---|
| Telemetría protegida válida | candidate no atribuido | PROBADO |
| Legacy | `unsupported-document` | PROBADO |
| Fuente/evento/identidad ausentes | código específico | PROBADO |
| Identidad contradictoria | `conflicting-identity` | PROBADO |
| Sin capacidad externa | `unverified-provenance` | PROBADO |
| Schema y trust flag extra | `invalid-schema` | PROBADO |
| Timestamp inválido | `invalid-timestamp` | PROBADO |
| Timestamps declarados | separados y no atribuibles | PROBADO |
| Cero, null y ausencia | preservados sin conversión | PROBADO |
| Payload parcial/anidado | copia defensiva | PROBADO |
| Magnitud desconocida | permanece en payload técnico | PROBADO |
| Estado/conexión/desconexión | candidato técnico no medible | PROBADO |
| Retry exacto | misma tupla, sin ACK | PROBADO |
| Replay alterado | misma tupla, payload diferente, sin deduplicar | PROBADO |
| Campos empresariales/atribuidos | ausentes de la salida | PROBADO |
| Excepción de autoridad | cuarentena sanitizada | PROBADO |
| Determinismo | misma entrada/capacidad, mismo resultado | PROBADO |
| Inmutabilidad | entrada intacta y salida congelada | PROBADO |
| Entrada hostil | `internal-error` sin detalle | PROBADO |
| Procedencia falsificada en payload | no sustituye capacidad | PROBADO |
| Separación de persistencia/retry | sin responsabilidades del store | PROBADO |
| Capacidad usada para otro evento | `unverified-provenance` | PROBADO |
| Salida hostil del verifier | no emite capacidad ni propaga diagnóstico | PROBADO |
| Autoridad arbitraria | factory del mapper la rechaza | PROBADO |

La suite funcional contiene 37 casos automatizados y la auditoría adversarial agrega 27, para un total focalizado de 64. Se reutilizan los 14 fixtures BE13-01 sin modificarlos. Las capacidades positivas son dobles sintéticos locales y no prueban autenticación productiva.
