# MATRIZ BE13-11E — Benchmark local

**Todo número de este documento es `LOCAL_LAB_EVIDENCE`**: una sola máquina (16 CPU lógicas, 15.3 GB de RAM, win32), Docker en loopback, publishers sintéticos, EMQX 5.8.6, MongoDB 8.0 de 3 nodos en contenedores, MQTT.js 5.16.1, Node v24.19.0. **No es un SLO, un SLA, un límite productivo ni un dimensionamiento.**

Las cifras vienen de las **dos corridas finales completas** sobre el HEAD definitivo (`144dda0`): cada una 30/30 PASS, 0 FAIL, 0 NO_VERIFICABLE. Se muestran **RUN 1 | RUN 2** sin promediar percentiles. Script: `scripts/audit-be13-11e-emqx-bench.ts`.

## Cómo leer las latencias

- **Servicio** por evento: adapter→inbox ≈ 38–47 ms p50 (verificación + escritura majority + journal + auditoría) y ACK→medición ≈ 61–75 ms p50.
- **End-to-end desde la publicación** (p50 ≈ 8–11 s con 400 eventos) es sobre todo **tiempo de cola en el broker**: los publishers inundan más rápido de lo que el consumer atiende. No es la latencia de servicio.

## Escalado de publishers (T01–T04b, 400 eventos QoS 1) — eventos procesados por segundo

| Escenario | Eventos/s (RUN 1 · RUN 2) | adapter→inbox p50/p95/p99 ms (RUN 1 · RUN 2) | ACK→medición p50/p95/p99 ms (RUN 1 · RUN 2) | CPU de 1 núcleo (RUN 1 · RUN 2) |
|---|---|---|---|---|
| T01 1 publisher | 23.6 · 20.1 | 38.4/69.6/88.3 · 46.7/80.8/94.1 | 61.5/91.9/181.9 · 74.9/131.7/183.9 | 62.9 % · 60.6 % |
| T02 2 publishers | 22.5 · 22.9 | 40.4/71.6/85.8 · 40/68.1/91 | 67.1/112.8/165.4 · 64.7/103.4/146.4 | 51.5 % · 52.9 % |
| T03 5 publishers | 21.5 · 23.3 | 42.5/74.9/97.9 · 38.1/68/83.9 | 69.6/126.9/250.5 · 60.7/101.4/138.1 | 48.6 % · 52.9 % |
| T04 10 publishers | 20.5 · 23.2 | 44.6/78.9/99 · 39.3/67/79.8 | 74.2/127.7/194 · 63.4/103.1/166.2 | 50.6 % · 48.1 % |
| T04b 25 publishers | 23 · 21.7 | 38.9/70.4/81.3 · 42.3/71.5/83.7 | 66.9/113.3/187.5 · 71.2/113.8/154.7 | 45.2 % · 48.2 % |

**Conclusión medida:** el ritmo es prácticamente **plano** (≈ 20–24 eventos/s) de 1 a 25 publishers, con variación entre corridas de ±10 % (la propia máquina). El cuello está en el consumer. El proceso Node usa ≈ 45–63 % de **un** núcleo de 16: está limitado por **latencia de E/S serial** (escritura durable por entrega), no por CPU. Sin pérdida ni mediciones duplicadas.

### End-to-end (publicación → medición) p50 / p95 / p99 (máx), ms

| Escenario | RUN 1 | RUN 2 |
|---|---|---|
| T01 | 8477.7 / 16035.7 / 16721.8 (máx 16799.4) | 10912.3 / 18878 / 19566.8 (máx 19657.5) |
| T02 | 9308.7 / 16881.1 / 17589.4 (máx 17695.3) | 8966.5 / 16544.3 / 17232.9 (máx 17353.7) |
| T03 | 10114.7 / 17677.1 / 18352.8 (máx 18458.4) | 8326.7 / 16188.2 / 16914.2 (máx 17046.7) |
| T04 | 10241 / 18627.9 / 19274.7 (máx 19391) | 8815.5 / 16420.4 / 17112 (máx 17163) |
| T04b | 8799.8 / 16466.2 / 17203.9 (máx 17302.4) | 9645.5 / 17497.7 / 18213.4 (máx 18334.5) |

## Carga con duplicados (T05)

| | RUN 1 | RUN 2 |
|---|---|---|
| Eventos únicos | 200 | 200 |
| Mensajes publicados = escrituras de inbox | 235 | 239 |
| Mediciones | 200 | 200 |
| Eventos/s | 22.8 | 23 |

Cada duplicado cuesta una escritura durable de inbox, no una medición. La prueba exige además **0 filas de cuarentena** por duplicados: los duplicados se reportan como `duplicate`, nunca como conflicto (esto es lo que detecta el mutante M4).

## Serialización de ACK (T06) — handler con retardo artificial de 40 ms, ventana de publicación 64

| `receiveMaximum` | Handlers máx. R1 | Handlers máx. R2 | Eventos/s R1 | Eventos/s R2 |
|---|---|---|---|---|
| default | 1 | 1 | 3.3 | 3.5 |
| 1 | 1 | 1 | 14.2 | 14.5 |
| 10 | 1 | 1 | 14.2 | 14.6 |
| 100 | 1 | 1 | 14.7 | 14.6 |

El broker mantuvo hasta 32 mensajes en vuelo hacia el consumer (`inflight_cnt: 32`), pero el cliente los procesó **de a uno** en todos los perfiles: `receiveMaximum` no da paralelismo. El primer perfil (por defecto) fue ≈ 4× más lento que los otros tres en ambas corridas: **la causa no está establecida**.

## Procesamiento posterior al ACK (T28) — 150 ms de procesamiento inyectado por evento

| | RUN 1 | RUN 2 |
|---|---|---|
| Eventos únicos / procesados | 100 / 100 | 100 / 100 |
| Recepción (persist + ACK), eventos/s | 19.6 | 23.5 |
| Procesamiento, eventos/s | 18.9 | 22.3 |
| Eventos sin medición | 0 | 0 |

El procesamiento posterior se **solapa** con la recepción: ni la bloquea ni pierde eventos (la base sin retardo es ≈ 20–24/s). Demostrado solo en este laboratorio local; **no** implica que exista un worker productivo.

## Mongo lento (T07) — 25 ms artificiales en el borde del inbox (la escritura sigue siendo real y majority)

| | RUN 1 | RUN 2 |
|---|---|---|
| Eventos/s | 17.3 | 17 |
| adapter→inbox p50 / p95 (ms) | 55.1 / 68.8 | 56.2 / 68.3 |

El ritmo cae aproximadamente lo que cuesta el retardo: el consumer es serial en la persistencia.

## Fallos bajo carga (T08–T11)

| Escenario | RUN 1 | RUN 2 |
|---|---|---|
| T08 Majority perdida ~8 s | 240 med. + 0 cuarentena, 0 perdidos; 11.5/s | 240 med. + 0 cuarentena, 0 perdidos; 12.2/s |
| T09 Failover del primary | 239 med. + 1 cuarentena, 0 perdidos; 7.3/s | 240 med. + 0 cuarentena, 0 perdidos; 5/s |
| T10 Reinicio de EMQX | 146 perdidos de 200; 1.9/s | 145 perdidos de 200; 2/s |
| T11 Reinicio del consumer ×3 | 240 med. + 0 cuarentena, 0 perdidos; 14.7/s | 240 med. + 0 cuarentena, 0 perdidos; 14.9/s |

En T09 el resultado **no es determinista**: en RUN 1 un evento ACKeado terminó en **cuarentena** (reintentable por replay); en RUN 2 todos terminaron como medición. En ningún caso se perdió un evento. T10 sí pierde eventos (ver `MATRIZ_BE13_11E_FAILURES.md`, F-E2).

## Sesiones y consumers (T12–T15)

| Escenario | RUN 1 | RUN 2 |
|---|---|---|
| T12 S1 clean start, entregados al volver | 0 de 20 | 0 de 20 |
| T12 S2 sesión persistente | 20 de 20 | 20 de 20 |
| T13 ráfaga de reconexión | 200 eventos, 6 reinicios, principal equivocado: 0 | 200 eventos, 6 reinicios, principal equivocado: 0 |
| T14 dos `clientId` (sin compartir) | 60 eventos → 120 entregas, 120 registros, 60 mediciones | 60 → 120, 120, 60 |
| T15 suscripción compartida, un miembro muere | 111 procesados de 160, perdidos 49; reparto 80/31 | 112 de 160, perdidos 48; reparto 80/32 |

## Mensajes veneno y ataque (T16–T18b)

| Escenario | Resultado (ambas corridas) |
|---|---|
| T16 JSON inválido ×50 con `ack-and-drop` | 50 recibidos, 0 en inbox, 0 reentregas |
| T16 un mensaje veneno con política `withhold` | 10 y 10 entregas del mismo mensaje en 9 s (bucle mientras no se ACKee) |
| T17 clave técnica cruzada ×100 | 0 inbox / 0 cuarentena / 0 mediciones; 122 y 159.1 mensajes/s |
| T18 principal sin mapping ×200 | 0 / 0 / 0; CPU 25.9 % y 29.8 % |
| T18b credenciales inválidas ×40 | 40 rechazadas por el broker; el adapter no recibe nada |

## Recuperación por lotes con 3 ejecutores (T19, T20)

| | RUN 1 | RUN 2 |
|---|---|---|
| T19 `receipted`: 30 registros | recovered 30, stale 48, duplicate 12; 8.2/s | recovered 30, stale 52, duplicate 8; 10.9/s |
| T20 huérfanos: 20 registros | recovered 20, stale 30, duplicate 10; 8.5/s | recovered 20, stale 24, duplicate 16; 9.6/s |

Cada registro se recuperó **exactamente una vez** entre los tres ejecutores (claim con CAS) y produjo una sola medición.

## Auditoría (T21) — apéndices concurrentes al mismo stream de realm (100 por nivel, 0 errores)

| Concurrencia | Apéndices/s RUN 1 | RUN 2 | p95 ms RUN 1 | RUN 2 |
|---:|---:|---:|---:|---:|
| 1 | 184.1 | 199.4 | 7.1 | 6.5 |
| 5 | 109.8 | 145.2 | 158.6 | 214.1 |
| 10 | 71.6 | 79.9 | 555.1 | 528.5 |
| 20 | 45.1 | 59 | 1587.1 | 1330.1 |

El throughput total **cae** al subir la concurrencia (contención sobre un contador por stream), pero con **un** consumer (una conexión, el caso probado en T01–T05) no apareció como cuello: el apéndice tuvo p50 ≈ 7 ms y p95 ≈ 48 ms bajo carga. `NO BOTTLENECK DEMONSTRATED AT TESTED LOAD` para un consumer; sí es un límite a vigilar si se escala a varias conexiones.

## Payload (T22)

| Payload | Eventos/s RUN 1 | RUN 2 |
|---|---:|---:|
| pequeño | 22.9 | 25.4 |
| cercano al límite TEST_ONLY (3903 B crudos, doc de inbox 4660 B) | 22.5 | 25.4 |

## Orden (T23, T24)

| | RUN 1 | RUN 2 |
|---|---|---|
| Persistencia por fuente, violaciones | 0 (T23) / 0 (T24) | 0 / 0 |
| Medición, una fuente secuencial (80 eventos) | 3 inversiones | 1 inversiones |
| Medición por fuente con 5 publishers | 0 | 1 |

No existe orden global ni se promete orden por fuente en las mediciones.

## Dataset a escala (T26): 30 000 registros de inbox sintéticos + 10 000 estados `receipted`

| Consulta | RUN 1 | RUN 2 | Plan |
|---|---:|---:|---|
| `listCandidates` (límite 100) | 870 ms | 873 ms | usa `inbox_realm_persisted`, sin COLLSCAN; el costo viene del `$lookup` por registro sin estado |
| `listReceiptedCandidates` | 3.1 ms | 2.4 ms | usa `state_realm_status_receipted` |
| `count` (límite 500) | 55.7 ms | 42.3 ms | — |

Documento medio: 1282 B (payload de 600 B). 1282 B/event x 100 ev/s x 86400 s = 10563.4 MB/day (ILLUSTRATION, not sizing; excludes indexes, journal and audit)

## Recursos (T27)

| | RUN 1 | RUN 2 |
|---|---|---|
| RSS MB (mín–máx) | 98.8–440.6 | 100–447.8 |
| Heap usado MB (mín–máx) | 30.3–213.5 | 30.3–211.4 |
| Event loop p50 / p99 / máx (ms) | 6 / 19.9 / 443.3 | 5.7 / 19.8 / 332.4 |

No se afirma una fuga: el arnés conserva mapas y logs por diseño.
