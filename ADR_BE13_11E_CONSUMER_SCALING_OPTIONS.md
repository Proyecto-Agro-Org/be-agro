# ADR BE13-11E — Opciones de escalado del consumer (sin elegir)

Estado: **análisis**, no decisión. Evidencia `LOCAL_LAB_EVIDENCE` de `MATRIZ_BE13_11E_BENCHMARK.md` y `MATRIZ_BE13_11E_FAILURES.md`. Restricción innegociable: **receipt durable majority → ACK → procesamiento**; cualquier opción que ACKee antes se rechaza.

## Cuello de botella identificado

Un consumer con una conexión atiende **una entrega a la vez**: escribe en el inbox (`w: majority, j: true`), libera el ACK y lanza el procesamiento. Por eso el ritmo de eventos procesados es prácticamente el mismo con 1, 2, 5, 10 o 25 publishers: el límite está del lado del consumer, no del broker ni de los publishers. Dos efectos secundarios medidos: el backlog crece **en el broker** (la cola de la sesión) y esa cola es **memoria del broker**, que un reinicio sin sesiones durables pierde.

## Opciones

| Opción | Qué es | A favor | En contra / evidencia |
|---|---|---|---|
| A. Un consumer serial (hoy) | una conexión, una entrega a la vez | simple, orden de persistencia por fuente, ninguna duplicación | techo de throughput; cola en el broker; el reinicio del broker pierde la cola |
| B. Varios consumers con suscripción compartida | `$share/<grupo>/…` | reparte la carga sin duplicar (T15) | un miembro de sesión limpia que cae **pierde** lo que tenía (T15); orden por fuente no garantizado entre miembros; sesiones y reentrega por miembro |
| C. Particionar por topic técnico | un consumer por partición de topics | orden dentro de la partición | el topic no es autoridad de negocio; ACL y operación más complejas |
| D. Particionar por `sourceId` tras autenticar | enrutar por fuente | orden por fuente | requiere una capa previa (el `sourceId` sale del mapping, no del topic) |
| E. Separar consumer y procesador | consumer: recibir → verificar → inbox → ACK; procesador: inbox → pipeline | libera la conexión del trabajo pesado; el procesamiento escala por separado | exige worker (no existe, decisión 32/33/47); el procesamiento ya corre asíncrono tras el ACK, así que la ganancia está en aislar CPU y fallos, no en el ritmo de ingesta |
| F. Varios `clientId` sin compartir | dos sesiones suscritas al mismo topic | — | **duplica todo** (T14: 60 eventos ⇒ 120 entregas); descartada |

## Lectura

- El techo de A se debe sobre todo a la persistencia durable por entrega (≈40 ms de escritura majority + journal en este laboratorio). Subir el throughput exige **más conexiones concurrentes** (B, C o D), no más publishers.
- E no acelera la ingesta por sí sola: la persistencia en el inbox sigue siendo serial por conexión. Aporta aislamiento y recuperación.
- Cualquier opción con varias conexiones introduce: idempotencia como defensa final (ya existe), reordenamiento entre conexiones, y política de sesión.
- **Antes de elegir** faltan los requisitos de negocio: throughput requerido, latencia aceptable, necesidad de orden por fuente, durabilidad de sesiones del broker (decisiones 53–60).

## No decidido

Modelo de concurrencia, uso de suscripciones compartidas, límite de inflight, expiración de sesión, reconexión y backoff, manejo de mensajes veneno y dimensionamiento del inbox.
