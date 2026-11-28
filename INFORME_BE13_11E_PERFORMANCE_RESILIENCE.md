# INFORME BE13-11E — Throughput, concurrencia, sesiones y resiliencia del consumer EMQX local

Fecha: 2026-11-25. Base: `dev` `076a1260673ecac4a2778fadb3b1a9dd8135ce03`; `main` `1bb20f76b7a739f42c75b37b9a64315276560ec1` (intacto). Todo en loopback, con credenciales TEST_ONLY generadas por corrida. Sin Atlas, hardware, Production ni autenticación productiva elegida. `productionReady` = `false`.

> **Etiqueta obligatoria:** toda cifra es `LOCAL_LAB_EVIDENCE`. No es un SLO, un SLA, un límite ni un dimensionamiento.

## 1. Hecho medido

| Medición | Resultado |
|---|---|
| Ritmo del consumer actual (1 conexión, QoS 1) | ≈ 20–24 eventos/s, **plano** de 1 a 25 publishers |
| Costo de servicio por evento | adapter→inbox ≈ 38–47 ms p50; ACK→medición ≈ 61–75 ms p50 |
| Latencia end-to-end desde la publicación (400 eventos) | p50 ≈ 8–11 s: es **cola del broker**, no costo de servicio |
| Entregas concurrentes por conexión | **1**, con cualquier `receiveMaximum` (1, 10, 100) y cualquier ventana de publicación |
| Procesamiento posterior al ACK (T28, 150 ms inyectados) | solapado con la recepción; 100/100 procesados, 0 sin medición |
| Duplicados (T05, ≈ 50 % de reentregas) | una escritura de inbox por duplicado, **una** medición por evento, 0 cuarentenas por duplicados |
| Mongo con 25 ms extra (T07) | cae a ≈ 17 eventos/s: el costo se suma, el consumer es serial |
| Majority perdida ~8 s bajo carga (T08) | 0 pérdidas; sin ACK sin receipt |
| Failover del primary bajo carga (T09) | 0 pérdidas; en 1 de 2 corridas un evento quedó en cuarentena |
| Reinicio del consumer ×3 (T11) | 0 pérdidas, 50–55 reentregas |
| **Reinicio de EMQX bajo carga (T10)** | **145–146 de 200 perdidos** |
| Sesión limpia con el consumer offline (T12) | 0 de 20 entregados; sesión persistente: 20 de 20 |
| Dos `clientId` en el mismo topic (T14) | 60 eventos ⇒ 120 entregas y 120 registros, 60 mediciones |
| Suscripción compartida con un miembro muerto (T15) | sin duplicar, pero 48–49 de 160 perdidos (sesión limpia) |
| Mensaje veneno con `withhold` (T16) | 10 entregas del mismo mensaje en 9 s (bucle) |
| Recuperación por lotes con 3 ejecutores (T19, T20) | 30 y 20 registros recuperados **exactamente una vez**, ≈ 8–11 por segundo |
| Auditoría con apéndices concurrentes (T21) | ≈ 185–200/s con 1; ≈ 45–60/s con 20 |
| Consulta de candidatos a 30 000 filas (T26) | ≈ 0.9 s (`listCandidates`), 2–3 ms (`receipted`) |
| Memoria (T27) | RSS ≈ 100–450 MB, event loop p99 ≈ 20 ms |

## 2. Cuello de botella principal

El **consumer serial**, y dentro de él la **persistencia durable por entrega** (escritura majority + journal + auditoría ≈ 40 ms, más el ACK). Evidencia:

- el ritmo no cambia de 1 a 25 publishers, así que no es el broker ni los publishers;
- el proceso Node usa ≈ 45–63 % de **un** núcleo de 16: no es CPU, es latencia de E/S serial;
- el retardo artificial de 25 ms en Mongo baja el ritmo casi lo que cuesta ese retardo (T07);
- el procesamiento posterior al ACK no es el cuello: con 150 ms extra por evento, la recepción se mantiene (T28);
- la idempotencia y la cuarentena no aparecen en el perfil de servicio.

## 3. Interpretación

- Para escalar la **ingesta** hay que atender **más de una entrega a la vez**, lo que implica más conexiones. Más publishers o `receiveMaximum` no sirven.
- Más conexiones traen costos medidos: duplicación si son `clientId` distintos sin compartir (T14); pérdida del miembro muerto si la sesión es limpia (T15); y la **auditoría** pasa a ser contención (T21), porque cada apéndice incrementa un contador por stream.
- Separar consumer y procesador (recibir → inbox → ACK; luego inbox → pipeline) es viable en laboratorio (T28) y aísla el trabajo posterior al ACK, pero **no acelera la persistencia**.
- La fragilidad más seria no es de rendimiento sino de **durabilidad antes del consumer**: la cola de la sesión del broker es memoria (T10).

## 4. No demostrado

Capacidad productiva; SLO/SLA; comportamiento en Atlas; clustering de EMQX; hardware real; escala de más de ≈ 400 eventos por escenario; rendimiento con TLS o mTLS; carga sostenida de horas.

## 5. Hallazgos y correcciones

Ver `MATRIZ_BE13_11E_FAILURES.md`:

- **F-E1 (alto, corregido):** un resultado `uncertain` marcaba el registro como `completed` y el evento quedaba irrecuperable. Corregido en `processRecord`; pruebas S05/S06.
- **F-E3 (medio, corregido):** `start()` del adapter podía colgarse. Prueba S07.
- **F-E2 (alto, abierto):** reinicio del broker pierde la cola de sesión.
- F-E4 (contención de auditoría), F-E5 (bucle de veneno), F-E6 (suscripción compartida con sesión limpia), F-E7 (costo de barrido), F-E8 (anomalía no explicada de T06), F-E9 y F-E10.

## 6. Verificación

| Verificación | Resultado |
|---|---|
| Benchmark final, HEAD definitivo | RUN 1: 30/30 PASS; RUN 2: 30/30 PASS; 0 NO_VERIFICABLE; 0 contenedores residuales |
| Suite offline | **1021/1021** (1014 previas + 7 nuevas: S01–S07) |
| HTTP | 13/13 |
| Mutantes válidos | **7/7** (ver `MATRIZ_BE13_11E_BENCHMARK.md` y abajo) |
| Regresiones Mongo | BE13-11D 34/34, 11C 23/23, 11B 27/27, 11A 13/13, 10B 28/28 |

**Regresiones reutilizadas:** corridas sobre el HEAD `ba9cd88`. Desde entonces solo cambió `scripts/audit-be13-11e-emqx-bench.ts` (ni `src`, ni repositorios, ni servicios, ni adapters, ni contratos), así que siguen siendo válidas.

## 7. Mutantes

| # | Mutación | Capa | Detectado por |
|---|---|---|---|
| M1 | ACK liberado antes de la decisión del inbox | offline | D06, D07, D08, D12 (4 fallos) |
| M2 | procesamiento posterior con estado compartido (último `inboxId`) | campaña real | **T28**: 32 de 60 eventos sin medición |
| M3 | principal cacheado entre entregas/reconexiones | offline | D13, A10/A11 (2 fallos) |
| M4 | idempotencia omitida: el `lookup` no ve el claim **y** el claim transaccional devuelve conflict | campaña real | **T05**: los duplicados terminan en cuarentena |
| M5 | recuperación por lotes sin CAS | campaña real | **T19**: recuperado ≠ K |
| M6 | resultado de suscripción compartida tratado como único | N/A | ningún código asume unicidad: la idempotencia de negocio es la defensa final (T14, T15) |
| M7 | error de auditoría convertido en éxito | N/A | la auditoría es *best-effort* por diseño y nunca decide un resultado (pruebas de 11B) |

**Score:** 5 de 5 mutantes válidos aplicables a código murieron (**5/5 = 100 %**); M6 y M7 son N/A justificados. Dos intentos **inválidos** no cuentan: el primer M4 era un error de sintaxis y su segunda versión (solo el claim transaccional) sobrevivió porque el `lookup` previo ya resuelve los duplicados; se corrigió para romper ambas capas. M2 sobrevivió una vez cuando la campaña no tenía procesamiento diferido (equivalente bajo la serialización actual) y murió al agregar T28.

## 8. Decisiones humanas

Nuevas 53–62 en `MATRIZ_DECISIONES_HUMANAS_BE13.md` (sin elegir): throughput, latencia, modelo de concurrencia, orden por `sourceId`, suscripciones compartidas, inflight, durabilidad de sesiones del broker, escalado de auditoría, dimensionamiento del inbox y mensajes veneno.

## 9. Riesgos residuales

Cola de sesión del broker en memoria; contención de auditoría al escalar; mensajes veneno sin política; costo de barrido creciente; autenticación productiva pendiente; adapter, regla y ACL son TCB; números de una sola máquina.
