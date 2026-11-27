# INFORME BE14-05 — Readiness gate para integrar un publisher/firmware real

**Clasificación: `READY_FOR_PLATFORM_DECISION`.** Toda la preparación técnica disponible está hecha; falta elegir plataforma (D1). `productionReady=false`. No se construyó firmware, no se eligió hardware, no se agregó otra capa de simulación. BE13/BE14-01…04 no se reabrieron.

## 1. Por qué no se implementa firmware
No existe plataforma elegida ni publisher real. Escribir firmware sin plataforma obligaría a inventar almacenamiento, librería MQTT y auth. En cambio se convirtió BE14-01→04 en un paquete que responde a cuatro preguntas:
| Pregunta | Dónde se responde |
|---|---|
| ¿Qué debe implementar el dispositivo? | `ESPECIFICACION_BE14_FUTURE_PUBLISHER_REQUIREMENTS.md` (77 requisitos: **50 MUST**, 8 SHOULD, 14 PENDING_PRODUCT_DECISION, 5 PLATFORM_SPECIFIC) |
| ¿Qué debe decidir producto? | misma especificación §14 (D1–D17, ninguna `DECIDED`) y `PLANTILLA_BE14_PUBLISHER_PLATFORM_INPUT.md` |
| ¿Qué podemos empezar sin esas decisiones? | `PLAN_BE14_FIRMWARE_IMPLEMENTATION.md` (FW-02, FW-05, FW-06, FW-07 sobre puertos; **solo D1/D10 bloquean el inicio**) |
| ¿Cómo sabemos si el firmware cumple? | `MATRIZ_BE14_REQUIREMENT_TO_CONFORMANCE.md` + kit L0–L5 + onboarding Mode B (`RUNBOOK_BE14_03_CERTIFICAR_PUBLISHER.md`) |

## 2. Contratos consolidados (verificados contra el código, no solo contra documentos)
- **`eventId`**: `^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$`, 1–128, sensible a mayúsculas, sin `.`, sin normalización, retry conserva el id. `<clave>:<seq>` es **estrategia de referencia**, no requisito universal; propiedades obligatorias: estabilidad, unicidad, persistencia, recuperación tras reboot.
- **`deviceTimestamp`**: único valor procesable = **entero seguro ≥ 0** (esquema del parser acepta string/number/null, pero el pipeline cuarentena lo que no sea entero ≥ 0). **Unidad**: epoch en ms **por convención** (vectores/referencia); **el backend no la impone** y no usa el valor declarado como autoridad temporal (usa `received-at`; `declared-at` no está aprobado). Se fijó la unidad como SHOULD y la autoridad como decisión pendiente (D15). Riesgo registrado: `0` es aceptado.
- **Payload/hash**: una sola serialización alimenta outbox, publicación y SHA-256; **los reintentos deben ser byte-idénticos** (el backend decide `conflict` por hash, no por semántica).
- **MQTT**: `clientId` = identidad técnica (≠ tenant/`sourceId`/`eventId`); una conexión por identidad; **QoS 1**; `PUBACK = BROKER_ACCEPTED` (ni entrega, ni durabilidad, ni éxito). Topic: *contrato de pruebas* `agro/lab/in/<x>` vs **topic productivo PENDING** (los de `iot-ingest` son strings opacos).
- **Outbox**: durable, persistir antes de publicar, registro mínimo, atomicidad como propiedad (sin elegir flash/FS), fail-closed ante corrupción, nunca descarte silencioso, saturación explícita.
- **Reintentos**: semántica obligatoria (finito, mismo id y bytes, backoff, sin bucle agresivo, agotamiento explícito) separada de los **valores** (PENDING, los de 11K siguen `PROPOSED`); dos carriles = SHOULD.
- **Reconciliación**: éxito solo con `processed|duplicate-confirmed|received-durable`; `conflict` terminal que requiere revisión (sin id de reemplazo); `quarantined` terminal; `UNCONFIRMED_EXPLICIT` retenido con diagnóstico, ownership pendiente; 429 con `Retry-After`; HTTP = `RECOMMENDATION_READY`.
- **Seguridad**: auth MQTT/HTTP `BLOCKED_BY_POLICY`; matriz conceptual de opciones (usuario/clave, API key, JWT, mTLS, firma, otro) **sin elegir**; almacenamiento seguro solo si se aprueban secretos.
- **Capacidad**: fórmulas de almacenamiento y red + utilidad `scripts/be14-05/capacity.ts` (solo aritmética, sin valores por defecto, sin hardware).

## 3. Decisiones que bloquean / no bloquean
- **BLOCKS FIRMWARE START**: D1 plataforma (y D10 almacenamiento, derivada; D7 capacidad solo para dimensionar).
- **BLOCKS PRODUCTION ONLY**: D2/D3 auth, D5/D6 valores de retry, D8 saturación, D9 owner de `UNCONFIRMED`, D11 credenciales, D13 rate limits, D14 broker/topic productivo, D15 reloj.
- **CAN WAIT**: D4 HTTP definitivo (`RECOMMENDATION_READY`), D12 OTA, D16 límites de payload.
- **D17** (nuevo, bloquea solo el veredicto `PASS EXTERNAL`, no el inicio): estrategia para L2-04 contra un broker real.
Ninguna decisión se marcó `DECIDED`.

## 4. Auditoría requisito → contrato → referencia → test (gap analysis)
Cobertura: los 50 MUST tienen verificación; **48 con test del kit**, 2 por `REVIEW` (REQ-SEC-01, REQ-OBS-02: no automatizables como caja negra). Se encontraron **tres brechas reales y una limitación**, todas pequeñas y tratadas dentro de BE14-05 salvo la última:
| # | Hallazgo | Tratamiento |
|---|---|---|
| G1 | **QoS 1 era MUST sin test** (el kit no miraba el QoS publicado) | corregido: el mundo y el observador registran `qos`; L1-01 → `QOS_NOT_1` |
| G2 | **Reutilización de `eventId` con otros bytes** probada solo en la referencia | corregido: L0-09 ampliado (mismo contenido idempotente / otro contenido rechazado / entrada intacta) |
| G3 | **Contradicción del veredicto**: `requiredTestIds` excluía L4-03/L4-04 (SKIP por `DECISION_PENDING`) ⇒ un firmware sin hooks de capacidad/política podía ganar `PASS EXTERNAL` sin verificar "no silent drop" ni "agotamiento explícito" | corregido: todo test no opcional es requerido |
| G4 | **L2-04 no es inyectable contra un broker real** con el observador actual ⇒ un publisher real quedaría `INCOMPLETE` aunque cumpla | **no corregido** (sería otra capa de infraestructura): decisión D17 con opciones (proxy TCP de fallos / hook en el puente del firmware / renuncia humana) |

Tests agregados: **10** (`test/be14-05-readiness.test.js`: coherencia de clases, trazabilidad espec↔matriz↔catálogo, cobertura de MUST, ninguna decisión `DECIDED`, 3 pruebas de brechas con mutantes —QoS 0 y reutilización aceptada fallan—, 3 de capacidad). Los tests existentes se mantienen (el puente mock de BE14-03 ahora respeta la regla de reutilización).

## 5. Mode B y primera corrida real
Contrato del puente **sin cambios** (stdio JSON-lines). Para optar a todos los tests requeridos el firmware o su adapter debe declarar `crash-injection`, `clock-control`, `capacity-config`, `policy-config`, `outbox-corruption`. Onboarding (8 pasos) y orden L0→L1→L2→L3→L4→L5 con parada por nivel ante un FAIL de MUST en el runbook. Hoy el Mode B real sigue **`CONFORMANCE INCOMPLETE`** (correcto: no hay publisher).

## 6. Conformidad ≠ readiness
`CONFORMANCE PASS LOCAL/EXTERNAL` significa que cumple el contrato ejecutable; **no** implica `productionReady`. Un firmware que pase L0–L5 seguirá con `productionReady=false` mientras haya decisiones, pruebas de campo, seguridad, OTA y operación pendientes.

## 7. Riesgos
1. `deviceTimestamp` acepta `0` y el backend no define reloj sin sincronizar: un firmware ingenuo podría enviar `0` y pasar.
2. L2-04 no ejecutable externamente (D17).
3. La autoselfcheck de BE14-04 (EMQX) **no se volvió a ejecutar** en esta etapa (sin Docker, por diseño); los cambios (QoS en el observador, L0-09, L1-01) se cubren con la suite y el mundo simulado.
4. Sin plataforma no se pueden validar restricciones de flash/atomicidad: siguen `PLATFORM_SPECIFIC`.

## 8. Siguiente acción humana concreta
Completar `PLANTILLA_BE14_PUBLISHER_PLATFORM_INPUT.md` (A y la comparación C) y decidir **D1 (plataforma)** y **D10 (almacenamiento)**. Con eso se abre FW-01. Hasta entonces el desarrollo técnico del publisher se detiene.
