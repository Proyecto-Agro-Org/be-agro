# PLAN — Implementación futura del firmware publisher (alto nivel, NO se ejecuta) — BE14-05

Este plan **no elige plataforma ni lenguaje** y no autoriza empezar nada por sí mismo. Responde: *¿qué podemos empezar sin las decisiones pendientes y qué no?* Referencias: `ESPECIFICACION_BE14_FUTURE_PUBLISHER_REQUIREMENTS.md` (requisitos y decisiones D1–D17), `MATRIZ_BE14_REQUIREMENT_TO_CONFORMANCE.md`.

## Qué se puede empezar sin esas decisiones
Todo lo que sea **máquina de estados y contrato**, parametrizado por puertos (como la referencia, con defaults `BLOCKED`): generador de `eventId`, serializador de bytes + hash, outbox como puerto de almacenamiento, cliente de reconciliación como puerto, política de reintentos con valores inyectados, observabilidad. **Lo único que bloquea el inicio es la plataforma (D1)** y, derivada, la tecnología de almacenamiento (D10). Nada de auth definitiva, valores de retry, rate limits, OTA ni broker productivo bloquea el arranque.

## Épicas
| Épica | Alcance | Requisitos que cubre | Depende de | Puede empezar sin | Verifica |
|---|---|---|---|---|---|
| **FW-01 Platform bootstrap** | elegir/preparar plataforma, toolchain, memoria, reloj, almacenamiento, crypto SHA-256, watchdog, puente de conformidad factible | REQ-HW-01, REQ-MQ-09, REQ-OB-10, REQ-RC-11, REQ-SEC-03/04, REQ-RS-03, REQ-OTA-01 | **D1**, D10, D12 | — (es la épica bloqueante) | entrada de hardware (plantilla) |
| **FW-02 Canonical event creation** | identidad técnica, `eventId`, secuencia persistente, `deviceTimestamp` entero, sobre cerrado, serialización única, SHA-256 | REQ-ID-01/02, REQ-EID-*, REQ-TS-*, REQ-PL-* | D1 (solo para la secuencia) | D2–D9, D13, D14 | L0-* |
| **FW-03 Durable outbox** | persistir antes de publicar, registro mínimo, atomicidad, fail-closed, saturación explícita, retención | REQ-OB-*, REQ-RS-*, REQ-OF-01 | D1, D10 (y D7/D8 para dimensionar/decidir) | D2–D6, D13 | L3-*, L4-03 |
| **FW-04 MQTT transport** | `clientId` = identidad, una conexión, QoS 1, PUBACK = aceptado, reconexión, topic | REQ-MQ-*, REQ-ID-01 | D1 (librería); D14 para el topic productivo | auth definitiva (puerto de credenciales) | L1-*, L4-01 |
| **FW-05 Reconciliation client** | consulta HTTP, validación de respuesta, 429, 401/403, errores | REQ-RC-*, REQ-OF-03/04 | D1 (cliente HTTP); D3/D4 para producción | rate limits, auth definitiva | L0-08, L1-03, L2-*, L5-* |
| **FW-06 Retry policy** | carriles, backoff, jitter, agotamiento explícito | REQ-RT-*, REQ-EID-02 | valores D5/D6 solo para producción | los valores (se inyectan) | L2-*, L4-04 |
| **FW-07 Observability** | contadores y vista local del outbox, logs sin payload/secretos, exposición de `conflict`/`quarantined`/`UNCONFIRMED` | REQ-OBS-*, REQ-SEC-01, REQ-RC-07/08, REQ-OWN-01 | D9 (ownership) para el flujo humano | D9 | L3-06 + REVIEW |
| **FW-08 Conformance L0–L5** | puente stdio, capacidades (`crash-injection`, `clock-control`, `capacity-config`, `policy-config`, `outbox-corruption`), onboarding Mode B | todos | FW-02…FW-07; D17 para el veredicto | — | kit completo |

## Orden y criterio
`FW-01 → FW-02 → FW-03 → FW-04 → FW-05 → FW-06 → FW-07 → FW-08`; FW-02/FW-05/FW-06 pueden desarrollarse en paralelo sobre puertos mientras FW-01 cierra. La primera corrida real **no** ejecuta 40 pruebas juntas: sigue el orden de niveles de `RUNBOOK_BE14_03_CERTIFICAR_PUBLISHER.md` (L0 → L1 → L2 → L3 → L4 → L5) y se **detiene por nivel** ante un FAIL de un MUST.

## Aceptación y límites
Un firmware es `CONFORMANCE PASS LOCAL`/`EXTERNAL` solo con todos los tests requeridos aplicables en PASS; eso **no** es `productionReady`. Siguen fuera de este plan: pruebas de campo, seguridad productiva, OTA, operación (ownership de `UNCONFIRMED`), broker productivo.
