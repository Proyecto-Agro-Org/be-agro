# INFORME — BE14-04 Observador MQTT y fault-control para el modo externo del Publisher Conformance Kit

## Resumen
BE14-03 dejó el Modo B (publisher externo) preparado pero **incompleto**: los tests que necesitan un broker MQTT real quedaban `NOT_RUN`. BE14-04 agrega lo que faltaba **del lado de la infraestructura**: un observador MQTT black-box, un controlador de fallos externo, un orquestador de escenarios declarativo, negociación de capacidades y un etiquetado de veredictos honesto. **No hay publisher real** (ni firmware): el Modo B real sigue diciendo `INCOMPLETE`, y eso es lo correcto.

## Qué se construyó
- `scripts/be14-04/observer.ts` — `ExternalMqttObserver` (núcleo puro + fuente EMQX: suscriptor de la regla `lab_verify` + poll de la API de gestión).
- `scripts/be14-04/fault-controller.ts` — `ExternalFaultController` con guardas (loopback, etiqueta del run, sin borrar volúmenes, procedencia).
- `scripts/be14-04/external-world.ts` — el mismo mundo de BE14-03 (servicio/router real de BE13 + fallas HTTP) con la superficie MQTT respaldada por observador + controlador; el catálogo **no cambió**.
- `scripts/be14-04/scenario.ts`, `scenarios.ts` — orquestador y S1–S6.
- `scripts/be14-04/verdict.ts` — `CONFORMANCE PASS EXTERNAL` solo para un publisher real declarado; los test-doubles reciben `HARNESS_SELF_TEST`.
- Cambios aditivos en BE14-03: `runner.ts` (modo observado, capacidades, reporte), `adapter.ts` (`identity`, `mqttCredentials`), `external-config.ts` (secciones opcionales), `cli.ts`, `world.ts`/`catalog.ts` (superficie MQTT externa asíncrona), `reference-adapter.ts` (reloj real).
- `scripts/be13-11d/emqx-lab.ts`: re-login transparente de la API de gestión cuando el token muere por un stop/start externo.
- Puente de prueba `test-support/be14-04-test-bridge.mjs` (publisher de referencia con reloj real y MQTT real; se **auto-declara test-double**).

## Resultados
- Offline: 26 tests de observador/controlador/orquestador/veredicto/config + 16 de mutación (8 mutantes + controles) en verde.
- **Una** integración local (EMQX 5.8.6, Mongo no requerido para este kit): catálogo 38 tests = 37 PASS, 0 FAIL, 1 SKIP explícito (`L2-04`, no inyectable), 0 NOT_RUN; S1–S6 = 6/6 PASS (S6 negativo detectado); sin colisiones de clientId; mismos ids y bytes tras cada fallo. Veredicto: `HARNESS_SELF_TEST`, **no** `PASS EXTERNAL`.
- Control de honestidad: el modo externo **sin** observador (lo que hay hoy para un publisher real) sigue `CONFORMANCE INCOMPLETE`, salida 4.

## Hallazgos reales de la integración (valor del experimento)
La infraestructura real encontró defectos que el mundo simulado no puede mostrar. Todos eran del arnés, no del publisher:
1. **El observador quedaba ciego tras reiniciar el broker**: `mqtt.js` reconectaba pero con `reconnectPeriod: 0` y sin re-suscripción.
2. **Un SUBACK vacío o denegado durante el arranque** de EMQX se tomaba como "suscrito". Peor: EMQX **cachea el deny por conexión**, así que reintentar en la misma conexión no sirve; hay que descartar la conexión y reconectar.
3. **El token de la API de gestión muere** al hacer stop/start desde afuera (resuelto con re-login en `lab.api`).
4. Lección de diseño: `/status` = 200 **no** significa que el broker esté listo para autorizar. El controlador espera además `afterBrokerReady` (observador suscrito).

## Límites honestos
- `DUP` publisher-side: **no observable** por la regla del broker (`NOT_OBSERVABLE`).
- PUBACK: solo indirecto.
- Colisión de clientId en EMQX real: heurística (toma de sesión) vía poll; exacta solo en fuentes in-process.
- `drop-before-puback` no se puede inyectar desde afuera de un broker real ⇒ `SKIP`/`FAIL` explícito según `requiredFaults`.
- Los escenarios corren con reloj real: ~95 s el catálogo + ~20 s los escenarios.
- El mundo de evidencia (BE13) sigue siendo el simulado `TEST_ONLY`; no se validó contra el backend desplegado ni Mongo real en este kit.

## Estado
`productionReady = false`. Ninguna decisión humana quedó marcada como DECIDED. No se tocó `main`, Atlas, producción, firmware ni autenticación/retry. No se tocaron la red ni los volúmenes históricos de Docker.

## Siguiente paso real
Un publisher real (firmware/gateway) implementa el puente stdio, se declara `publisher.kind: real-external` y se ejecuta con `observer.enabled` + `faultControl.mode: lab-emqx`. Solo entonces puede emitirse `CONFORMANCE PASS EXTERNAL`.
