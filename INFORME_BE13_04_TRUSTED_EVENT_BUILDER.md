# BE13-04 — Trusted Event Builder

## Resumen

Etapa pura, offline y fail-closed: `ReadyForAttribution` (BE13-03) → revalidación obligatoria de las cinco autoridades → políticas explícitas → exactamente un `TrustedMeasurementEvent` validado por el schema real de BE-12, o cuarentena. Sin MongoDB, Atlas, EMQX, Express, rutas, persistencia, workers ni cambios en `app.ts`. Todas las políticas por defecto bloquean.

- Rama `feature/be13-04-trusted-event-builder`, worktree `.local-consolidacion/be13-04`.
- Base: `origin/dev` `6f6c5c884b31d63918c68306e36d052ff3e9f91e` (merge de BE13-03, PR #23).

Contrato: `CONTRATO_BE13_04_TRUSTED_EVENT.md`. Pruebas: `MATRIZ_BE13_04_PRUEBAS.md`. Compatibilidad: `MATRIZ_BE13_04_COMPATIBILIDAD_BE12.md`. Auditoría: `INFORME_BE13_04A_AUDITORIA_SEGURIDAD.md`, `MATRIZ_BE13_04A_VECTORES.md`.

## Arquitectura y archivos

| Archivo | Rol |
| --- | --- |
| `src/services/trusted-event-builder.service.ts` | Servicio coordinador y `assembleTrustedMeasurementEvent` (frontera con el schema BE-12) |
| `src/iot/trusted-event.contracts.ts` | Revalidadores, políticas, resultado, códigos |
| `src/iot/trusted-event.schemas.ts` | Schemas estrictos de decisiones de políticas |
| `src/adapters/trusted-event-blocking.policies.ts` | Políticas por defecto bloqueantes |
| `src/services/authority-call.ts` | **Extraído de BE13-03**: llamada acotada (timeout), validación Zod, realm, sin diagnósticos |
| `src/iot/trust-gate.queries.ts` | **Extraído de BE13-03**: construcción única de consultas, usada por gate y builder |
| `src/services/attribution-trust-gate.service.ts` | Refactor sin cambio de comportamiento (131/131 previas) + registro privado `ready → candidate` (`isIssuedReadyFor`) |
| `src/iot/trust-gate.type-assertions.ts` | Aserciones de compilación BE-12 ampliadas |
| `test/be13-04-trusted-event-builder.test.js`, `test/be13-04a-adversarial.test.js` | 36 + 18 pruebas |

## Procedencia del ready

Se evaluó un contrato más simple (aceptar cualquier objeto y confiar solo en la revalidación). Se descartó porque un ready fabricado podría elegir campos no revalidados (`field`, `value`, `eventId`, `device` con otro valor). Se usa el mismo patrón auditado del mapper: `WeakMap` privado en el módulo del gate, que vincula cada ready emitido con su candidate exacto, y solo se exporta la consulta. Es **procedencia intra-proceso**, no autenticación; un ready de otra instancia del módulo se rechaza.

## Revalidación

Obligatoria y sin bypass. Se comparan revisión **y** fingerprint de las cinco autoridades; cualquier diferencia → `stale-*`. Las consultas son idénticas a las del gate (probado). Un cambio solo de revisión cambia también el fingerprint (la revisión es contenido); "fingerprint igual y revisión distinta" exigiría una colisión SHA-256 (NO VERIFICABLE, no se asume).

No elimina TOCTOU: entre relecturas no hay atomicidad (un cambio revertido entre lecturas, ABA, no se detecta) y después de devolver el resultado el mundo puede cambiar. Por eso `revalidation:'required'` se conserva para BE-12.

## Decisiones (todas por política inyectable, todas bloqueantes por defecto)

- **declaredAt**: el contrato BE-11/BE-12 lo define como "timestamp declarado o `null`" (`CONTRATO_BE11_IOT_BE12.md`) sin elegir reloj. La política nombra la fuente (`device-timestamp`, `broker-sent-at`, `none`) y el valor debe ser el exacto del candidate. No hay parseo ISO ni conversión de unidades.
- **missingReason**: solo para `null`; números (0 incluido) llevan `null`; ausencia no llega a esta etapa.
- **persistedAt**: nunca se completa; nulo bloquea sin consultar; aprobado solo si coincide con el del candidate.
- **clock**: mapeo BE13-03 → BE-12 por política, con restricciones de consistencia (ver contrato). No se codifica ninguna equivalencia productiva.

## Realm

El realm es parte de cada consulta y cada respuesta de revalidador o política debe declararlo. Los registros BE-11 no tienen realm y no se modificaron. **Realm isolation is an adapter/storage responsibility.**

## Decisión arquitectónica pendiente — `DEVICE_STATUS_HISTORY_REQUIRED`

Estado: **BLOQUEADO**. BE-11 solo expone el lifecycle actual. Un dispositivo hoy `inactive`/`decommissioned` cambia el fingerprint de dispositivo y produce `stale-device`, aunque el evento sea histórico y válido. No se intenta resolver con timestamps del payload, con la asociación histórica ni reinterpretando el estado actual. Requiere: historial de lifecycle versionado en BE-11 (con `[validFrom, validTo)`), o una decisión aprobada de que una asociación vigente implica dispositivo operativo.

## Trust boundaries

Revalidadores y políticas son código del mismo proceso. Un caller con ejecución en el backend puede construir dobles que aprueben todo; los registros de procedencia no lo impiden. El trust boundary real es la **composición de la aplicación** (qué adapters se inyectan, revisados y versionados), que todavía no existe.

## Estado

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | Builder, contratos, schemas, políticas bloqueantes, registro de ready, extracción de helpers compartidos, aserciones de tipo |
| PROBADO | 36 funcionales + 18 adversariales; suite 610/610; HTTP 13/13; verificación de mutación de 3 controles |
| PENDIENTE | Adapters reales; composición; comparación del resultado BE-12 con `attribution`; idempotencia por `eventId` aguas abajo |
| BLOQUEADO | Políticas aprobadas (clock, declaredAt, missingReason, persistedAt); `DEVICE_STATUS_HISTORY_REQUIRED`; catálogo BE-04; atestación de hardware |
| NO VERIFICABLE | Seguridad frente a código hostil en el proceso; honestidad de autoridades consistentes; aislamiento de realm en almacenamiento |

## Riesgos residuales

- No existe ninguna autoridad ni política productiva.
- TOCTOU posterior y ABA entre relecturas.
- BE-12 resuelve con contratos sin versión/fingerprint (ver matriz de compatibilidad).
- Un mismo par (candidate, ready) puede construir el evento varias veces: la idempotencia corresponde a la persistencia futura.
- Timeout operativo provisional (5 s por llamada, hasta 9 llamadas).
