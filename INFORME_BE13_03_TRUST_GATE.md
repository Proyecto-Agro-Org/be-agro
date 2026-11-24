# BE13-03 — Gate de resolución de identidad y preparación para atribución

## Resumen

Se implementó una capa pura, offline y fail-closed que recibe un candidate de medición emitido por BE13-02, coordina cinco autoridades inyectables y produce `ready-for-attribution` o `quarantined`. No crea `TrustedMeasurementEvent`, no persiste, no monta rutas y no conecta servicios reales. Todas las autoridades por defecto bloquean.

- Rama: `feature/be13-03-trust-gate` (worktree `.local-consolidacion/be13-03`).
- Base: `origin/dev` `d14e9555426a9442379b1aae475c06438a16cd75`. `main` (`1bb20f7…`) no modificado.

Contrato detallado: `CONTRATO_BE13_03_READY_FOR_ATTRIBUTION.md`. Pruebas: `MATRIZ_BE13_03_PRUEBAS.md`. Compatibilidad: `MATRIZ_BE13_03_COMPATIBILIDAD_BE12.md`.

## Archivos

| Archivo | Rol |
| --- | --- |
| `src/iot/protected-candidate.registry.ts` | Registro en memoria (WeakSet) de candidates emitidos por BE13-02 |
| `src/iot/protected-ingest.mapper.ts` | **Cambio aditivo de una línea**: registra el candidate congelado antes de devolverlo. Sin cambio de contrato ni comportamiento observable |
| `src/iot/trust-gate.contracts.ts` | Puertos, decisiones, `ReadyForAttribution`, códigos de cuarentena |
| `src/iot/trust-gate.schemas.ts` | Schemas Zod estrictos (reutilizan `physicalDeviceSchema` y `sensorDeviceAssociationSchema` de BE-11, `catalogueRealmSchema`, `epoch`, `logicalKey`) |
| `src/adapters/trust-gate-blocking.adapters.ts` | Adapters por defecto que bloquean |
| `src/services/attribution-trust-gate.service.ts` | Servicio coordinador |
| `test/be13-03-trust-gate.test.js` | 39 pruebas |

## Autoridades

| Autoridad | Puerto | Reutiliza | Adapter por defecto |
| --- | --- | --- | --- |
| A. Dispositivo | `devices.resolve` | `PhysicalDevice` BE-11 (verification, lifecycle, version) | Sin dispositivos → `unresolved-device` |
| B. Asociación temporal | `associations.findAt` | `SensorDeviceAssociation` BE-11, `[validFrom, validTo)` | Sin registros → `missing-association` |
| C. Temporal | `temporal.decide` | Semántica de `TemporalDecision` BE-12, ampliada con `unresolved` y revisión | `untrusted-clock` |
| D. Catálogo | `catalogue.evaluate` | — (BE-04 no se declara productivo) | `unknown-magnitude` |
| E. Hardware/procedencia | `hardware.verify` | — (separado de la capacidad BE13-02) | `unverified` |

## Flujo

Candidate emitido → selección de campo → A → E → C → B (en el instante de C) → D → segunda lectura de A, E, C, B, D → resultado congelado. El primer fallo detiene el flujo. No hay fallback, no se elige el primer resultado, no se completan datos faltantes.

## Identidad y aislamiento multicliente — IMPLEMENTADO y PROBADO

- `clientId`, `fieldId`, `areaId`, `sensorId` solo provienen del registro de asociación devuelto por B para el instante autorizado.
- El candidate no tiene `clientId`; el caller solo puede elegir `field`, validado estrictamente.
- Ninguna consulta a autoridades contiene `clientId`.
- `sourceId` y `mqtt-clientid` nunca se usan como cliente (prueba #19 con payload `clientId` y `clientid` iguales a la clave MQTT).
- `physicalDeviceId` no implica cliente actual (prueba de reasignación posterior).
- A→B y A→B→A preservan propiedad histórica (#11, #12).
- Cada respuesta debe declarar el mismo `realm` que el gate; otro realm → `realm-mismatch`.

## Temporalidad — IMPLEMENTADO y PROBADO

- Semántica semiabierta `[validFrom, validTo)`: inclusivo en `validFrom`, exclusivo en `validTo`; ventanas adyacentes asignan el borde solo a la posterior.
- El instante autorizado debe ser exactamente uno de los relojes del candidate según el `clock` que declara la autoridad (`received-at` → `receivedAt`, `broker-declared-approved` → `sentAt`, `device-declared-approved` → `deviceTimestamp` numérico) y nunca posterior a `receivedAt`. Cualquier otro valor → `contradictory-authority`.
- No hay tolerancias, `Date.now()` ni reloj del sistema en la lógica.
- La asociación se consulta en el instante autorizado, nunca en "ahora".
- Evento tardío (F11): el dueño depende de la política temporal aprobada; con reloj incierto se bloquea sin caer a recepción.

## Magnitudes y unidades — IMPLEMENTADO y PROBADO

- Solo se acepta lo aprobado por el catálogo inyectado, que además debe repetir el campo evaluado.
- Sin normalización, sin conversión. `0` permanece `0`; `null` permanece `null`; un campo ausente es `absent-field`, nunca medición; valores no numéricos son `invalid-value`.
- `missingReason` no se infiere.

## Revalidación y concurrencia — IMPLEMENTADO y PROBADO

- Doble lectura de las cinco autoridades con comparación canónica (salidas Zod con orden de claves fijo). Cambio en asociación → `stale-association`; en el resto → `stale-resolution`.
- Se capturan `deviceVersion`, `associationId`, `associationRevision`, `temporalPolicyRevision`, `catalogueRevision`, `hardwareAttestationRevision`, y se marca `revalidation:'required'`.
- La doble lectura reduce pero no elimina TOCTOU: BE13-04/BE-12 deben releer y comparar revisiones antes de emitir atribución.
- Revisión de sesión de ingesta: NO_APLICA; no existe tal entidad en el código.

## Fail-closed — IMPLEMENTADO y PROBADO

| Situación | Resultado |
| --- | --- |
| Autoridad no responde (timeout operativo) | `dependency-error` |
| Lanza o rechaza | `dependency-error` |
| Tipo inválido, campos extra, página incompleta, getters/proxies hostiles | `invalid-authority-response` |
| Otro realm | `realm-mismatch` |
| Datos contradictorios (otra clave, otro dispositivo, ventana que no contiene el instante, instante inventado, origen contradictorio, campo distinto) | `contradictory-authority` |
| Ambigüedad | `ambiguous-device` / `overlapping-association` |
| Evidencia omitida | Rechazada por schema estricto |
| Cualquier error no previsto | `internal-error` |

Los resultados de cuarentena exponen solo `status`, `reason` y `eventId` (si el candidate era válido).

## Auditoría

| Vector | Hallazgo / mitigación | Estado |
| --- | --- | --- |
| Bypass de autoridades | No existe camino a `ready` sin las cinco autoridades; los defaults bloquean; gate vacío probado | MITIGADO |
| Candidate falsificado | Objetos estructuralmente idénticos eran aceptables por forma; se agregó registro de identidad de candidates emitidos | CORREGIDO |
| Spoofing de `clientId` | Sin entrada posible; probado con payload hostil | MITIGADO |
| Mezcla de realms | `realm` obligatorio y comparado en cada respuesta | MITIGADO |
| TOCTOU | Doble lectura + revisiones + `revalidation:'required'` | MITIGADO PARCIAL (residual documentado) |
| Uso de asociación actual | Consulta con instante autorizado; prueba histórica | MITIGADO |
| Fallback silencioso | Ningún reloj, autoridad ni valor sustituto | MITIGADO |
| Errores filtrados | Códigos cerrados; mensajes y stacks descartados | MITIGADO |
| Objetos mutables | Consultas y resultado congelados; salidas Zod copiadas | MITIGADO |
| Dependencias hostiles | Throw, rechazo, silencio, thenable hostil, Proxy, getters, mutación posterior de puertos | MITIGADO |
| Autoridad temporal arbitraria | Instante restringido a relojes del candidate y causalidad | CORREGIDO durante diseño |

## Riesgos residuales y limitaciones

- **Ninguna autoridad productiva existe.** `ready-for-attribution` solo se alcanza con dobles de prueba.
- El registro de candidates y la capacidad BE13-02 son fronteras intra-proceso: código con ejecución arbitraria en el backend comparte el dominio de confianza.
- `inactive-device` usa el lifecycle **actual** del dispositivo; BE-11 no expone lifecycle histórico. Un dispositivo hoy inactivo bloquea eventos históricos válidos (fail-closed).
- La asociación BE-11 no lleva `realm` por registro; el realm se valida en el sobre de la respuesta.
- La doble lectura no impide cambios posteriores a la segunda lectura.
- `payloadIntegrity` sigue `not-attested`: la autoridad de hardware confirma dispositivo, no bytes del payload.
- El timeout operativo (5 s por defecto) no está aprobado como SLO.
- La selección de campo depende del caller; un caller puede omitir campos, pero no fabricar atribución.

## Estado por categoría

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | Contratos, puertos, schemas, adapters bloqueantes, servicio coordinador, registro de candidates, códigos de cuarentena |
| PROBADO | 39 pruebas BE13-03; 528/528 suite; 64/64 BE13-02; 13/13 HTTP |
| PENDIENTE | Conversión a `TrustedMeasurementEvent` (BE13-04); mapeo `clock` → BE-12; `declaredAt`; `missingReason`; `persistedAt` nulo; lifecycle histórico de dispositivo |
| BLOQUEADO | Política temporal productiva; catálogo BE-04 productivo; atestación de hardware; registro de dispositivos y asociaciones reales; EMQX; Atlas |

## Condiciones para BE13-04

1. Decisión aprobada de política temporal (qué reloj y bajo qué condiciones) y su correspondencia con `clock` BE-12.
2. Decisión sobre `missingReason` para `null` y sobre `declaredAt`.
3. Regla para `persistedAt` nulo (esperar persistencia o rechazar).
4. Catálogo BE-04 aprobado como autoridad con revisión versionada.
5. Autoridad de hardware definida (método de atestación) o decisión explícita de diferirla.
6. Revalidación en BE13-04/BE-12 comparando todas las `revisions` capturadas.
7. Adapters reales de dispositivos/asociaciones sobre repositorios BE-11, revisados y con pruebas de realm.
8. BE-12 sin modificaciones para encajar; cualquier cambio de contrato BE-12 por PR propio.
