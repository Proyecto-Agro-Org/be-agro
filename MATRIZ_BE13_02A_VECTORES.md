# BE13-02A — Matriz de vectores adversariales

Base auditada: `035ff5de3c7c89fe3da9adb3abc2a1c85c51f035`. Los dobles de autoridad son exclusivamente sintéticos y no prueban EMQX ni hardware.

| Vector | Resultado verificado | Clasificación | Evidencia |
|---|---|---|---|
| Capacidad como objeto común | rechazada al construir mapper | SIN HALLAZGO | `ingest-provenance.authority.ts:11-14`; `be13-02-mapper.test.js:204-206` |
| Capacidad copiada/serializada | `unverified-provenance` | SIN HALLAZGO | `be13-02a-adversarial.test.js:69-73` |
| Capacidad de otra authority | `unverified-provenance` | SIN HALLAZGO | `be13-02a-adversarial.test.js:75-78` |
| Capacidad para otra fuente | `unverified-provenance` | SIN HALLAZGO | `be13-02a-adversarial.test.js:80-89` |
| Capacidad para otra operación | `unverified-provenance` | SIN HALLAZGO | `be13-02a-adversarial.test.js:80-89` |
| Capacidad para otro evento | `unverified-provenance` | SIN HALLAZGO | `be13-02a-adversarial.test.js:80-89` |
| Capacidad para otro dispositivo | `unverified-provenance` | SIN HALLAZGO | `be13-02a-adversarial.test.js:80-89` |
| Getter cambiante del verifier | antes emitía una capacidad con valor leído posteriormente; ahora snapshot único | MEDIO, CORREGIDO | `ingest-provenance.authority.ts:27-39`; `be13-02-mapper.test.js:230-240` |
| Reutilización para evento exacto | determinista y permitida | LÍMITE EXPLÍCITO | `be13-02a-adversarial.test.js:91-94` |
| Misma tupla con payload alterado | candidate con `payloadIntegrity:not-attested`; no deduplica | RIESGO RESIDUAL MEDIO | `protected-ingest.mapper.ts:110-112`; `be13-02a-adversarial.test.js:95-104` |
| Payload `trusted=true` | no sustituye capacidad | SIN HALLAZGO | `be13-02-mapper.test.js:181-185` |
| Payload con IDs empresariales | solo raw payload; nunca campos de autoridad del candidate | SIN HALLAZGO | `be13-02a-adversarial.test.js:145-150` |
| Documento `null`/`undefined`/array/string | `unsupported-document` | SIN HALLAZGO | `be13-02a-adversarial.test.js:27-30` |
| Identificadores escalares inválidos | códigos `missing-*` controlados | BAJO, CORREGIDO | `protected-ingest.mapper.ts:34-36`; `be13-02a-adversarial.test.js:32-36` |
| Propiedades extra | `invalid-schema` | SIN HALLAZGO | `be13-02a-adversarial.test.js:38-42` |
| NaN/Infinity | `invalid-payload` | SIN HALLAZGO | `be13-02a-adversarial.test.js:44-47` |
| Profundidad mayor a 16 | `invalid-payload` | SIN HALLAZGO | `protected-ingest.mapper.ts:16-27`; `be13-02a-adversarial.test.js:49-53` |
| Más de 10.000 nodos | `invalid-payload` | SIN HALLAZGO | `be13-02a-adversarial.test.js:55-58` |
| Propiedad propia `__proto__` | antes Zod la eliminaba; ahora se rechaza antes del parse | MEDIO, CORREGIDO | `protected-ingest.mapper.ts:73-79`; `be13-02a-adversarial.test.js:60-64` |
| Propiedad heredada de autoridad | no se copia | SIN HALLAZGO | `be13-02a-adversarial.test.js:66-69` |
| Proxy/getter hostil | cuarentena sanitizada | SIN HALLAZGO | `be13-02-mapper.test.js:174-179`; `be13-02a-adversarial.test.js:119-123` |
| Mutación posterior del input | no altera candidate | SIN HALLAZGO | `be13-02-mapper.test.js:167-172` |
| Mutación profunda del output | congelada; lanza `TypeError` | SIN HALLAZGO | `be13-02a-adversarial.test.js:112-117` |
| Topic nulo/wildcard/mayor a 1024 bytes | antes podía producir candidate; ahora `invalid-schema` | MEDIO, CORREGIDO | `protected-ingest.schemas.ts:6,27,35`; `be13-02-mapper.test.js:208-217` |
| `persistedAt < receivedAt` | antes candidate; ahora `invalid-timestamp` | MEDIO, CORREGIDO | `protected-ingest.mapper.ts:46-49`; `be13-02-mapper.test.js:219-223` |
| Relojes declarados fuera de orden | preservados y nunca confiables | SIN HALLAZGO | `be13-02a-adversarial.test.js:131-137` |
| Recepción contradictoria | `conflicting-identity` | SIN HALLAZGO | `be13-02a-adversarial.test.js:125-129` |
| Operación desconocida/cruzada | `unsupported-operation` | SIN HALLAZGO | `be13-02a-adversarial.test.js:143-147` |
| Candidate como `TrustedMeasurementEvent` | schema BE-12 lo rechaza | SIN HALLAZGO | `be13-02a-adversarial.test.js:152-155` |
| Secretos sintéticos en error/payload inválido | no aparecen en cuarentena | SIN HALLAZGO | `be13-02a-adversarial.test.js:157-162` |
| Orden de propiedades | misma semántica | SIN HALLAZGO | `be13-02a-adversarial.test.js:164-168` |
| Autenticidad productiva EMQX/hardware | no comprobable offline | NO VERIFICABLE | no existe verifier productivo ni evidencia real |
| Límite de 1 MB | corresponde a la frontera HTTP previa; el mapper aplica profundidad/presupuesto | PENDIENTE DE COMPOSICIÓN | `iot-ingest/protected-app.ts`; `protected-ingest.mapper.ts:16-27` |

## Lectura de severidades

No se encontraron hallazgos críticos ni altos. Los hallazgos medios permitían aceptar formas incompatibles, perder una señal peligrosa o expresar confianza de manera ambigua, pero nunca producían atribución empresarial ni `TrustedMeasurementEvent`. Todos fueron corregidos y cubiertos por regresiones.
