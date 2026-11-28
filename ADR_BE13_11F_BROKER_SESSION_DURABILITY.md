# ADR BE13-11F — Durabilidad de sesión del broker (alternativas, sin elegir)

Estado: **sin decisión**. Esto documenta opciones; no elige ninguna.

## Contexto

EMQX 5.8.6 CE con sesiones durables conserva la cola offline pero no garantiza el estado inflight ni la ventana PUBACK→escritura (ver `INFORME_BE13_11F_EMQX_DURABILITY.md`).

## Alternativas

| | Opción | A favor | En contra / riesgo |
|---|---|---|---|
| A | Sesiones durables de EMQX 5.8.6 CE (lo probado) | Cola offline sobrevive a restart y kill | Persisten D04 y D27; F-E2 sigue abierto |
| B | Reducir `flush_interval` / `max_items` | Ventana más corta, sin impacto medible en el laboratorio | No es cero; sin escritura síncrona |
| C | Versión posterior de EMQX (5.9/6.x) | Podría traer mejoras de durabilidad | **No evaluada** (no se subió la imagen); requiere revisar changelog y repetir la campaña |
| D | Otro broker o modo (p. ej. Kafka/cola con ACK durable, o MQTT con persistencia síncrona) | Garantía distinta | Cambio de arquitectura; fuera de alcance |
| E | Reconciliación en el publisher (re-envío con id e idempotencia) | Cubre la pérdida confirmada si el publisher guarda hasta una confirmación de extremo a extremo | Requiere cambio en dispositivos; hardware no verificado |
| F | Clúster / HA de EMQX | Quizá reduce pérdida por caída de un nodo | No probado; añade complejidad y decisiones de consenso |

Condición común: cualquier opción debe repetir la campaña (≥3 repeticiones, con reinicio y kill duro) antes de poder cerrar F-E2.
