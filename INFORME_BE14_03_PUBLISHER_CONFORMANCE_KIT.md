# INFORME BE14-03 — Publisher Conformance Kit

Estado: **`CONFORMANCE PASS LOCAL`** para la implementación de referencia (modo A). Modo B (publisher externo) **preparado, no ejecutado**: no existe firmware ni publisher real y no se inventó ninguno. No se eligió plataforma. `productionReady=false`. BE13, BE14-01 y BE14-02 no se reabrieron (los dos defectos de la referencia hallados por el kit se corrigieron como bugs reales, ver §5).

## 1. Arquitectura (`scripts/be14-03/`, solo tooling; no compuesto en la app)
| Pieza | Rol |
|---|---|
| `test-support/publisher-conformance-vectors.json` | vectores máquina-legibles: 6 payloads con bytes exactos + `payloadSha256` + parser esperado, 7 payloads inválidos, 21 `eventId` (válidos/ inválidos), 11 `deviceTimestamp`, 8 topics |
| `adapter.ts` | interfaz **black-box** (`boot/createEvent/advance/inspectPending/restart/shutdown` + opcionales `armCrash/setClock/corruptOutbox`) y puente **stdio JSON-lines** para publishers externos |
| `world.ts` | mundo simulado: MQTT falso (modos `normal`, `puback-no-delivery`, `drop-before-puback`, `down`, contabilidad de conexiones por `clientId`) + evidencia en memoria detrás del **servicio y router reales de BE13** con inyección de fallos HTTP (429, 401, 403, 5xx, timeout, reset, malformada, otro `eventId`, estado desconocido, estados forzados) |
| `reference-adapter.ts` | **MODO A**: conduce el publisher BE14-01 con reloj virtual, almacén de archivo, inyección de crash/corrupción |
| `catalog.ts` | 38 pruebas ejecutables L0–L5 (la especificación) |
| `runner.ts` / `cli.ts` | ejecución, veredicto, reporte JSON + resumen humano, códigos de salida; `npm run publisher:conformance` |
| `external-config.ts` + `be14-03.external.example.json` | configuración del **MODO B**: sin secretos (solo nombres de variables `*Env`), MQTT solo loopback, identidad canónica |
| `integrated.ts` | mapea la campaña integrada (EMQX + Mongo reales) al formato de resultados |

## 2. Niveles y pruebas
| Nivel | Pruebas | Qué verifica |
|---|---|---|
| L0 CONTRACT | 9 | vectores y parser; `eventId` canónico/único; forma del payload; **hash** == SHA-256 de los bytes == hash consultado; serialización determinista (opcional); **`deviceTimestamp`**; topic; forma de la consulta; entradas inválidas rechazadas |
| L1 DELIVERY | 5 | normal; **PUBACK ≠ éxito**; semántica de confirmación (8 estados); `clientId` = identidad técnica/estable/una conexión; reconexión |
| L2 RETRY | 10 | mismo `eventId`/bytes/hash; duplicado seguro; confirmación perdida; caída antes y después de PUBACK; `conflict` y `quarantined` terminales; HTTP 429 (+`Retry-After`), 401/403 (sin bucle agresivo), 5xx |
| L3 DURABILITY | 6 | restart; **matriz de crash C1–C6**; outbox corrupto fail-closed + escritura parcial; persistencia de secuencia; reloj repetido/retrocedido; sin pérdida silenciosa |
| L4 FAILURE RECOVERY | 5 | MQTT caído; reconciliación no disponible; saturación sin descarte silencioso; carril rápido/lento y agotamiento explícito; concurrencia (20 eventos) |
| L5 SECURITY BOUNDARY | 3 | respuesta de otro `eventId`; malformada/desconocida fail-closed; scope y cross-tenant |

## 3. Formato de resultado y salida
Por caso: `{testId, level, status PASS|FAIL|SKIP|NOT_RUN, evidence, durationMs, failureCode}`; reporte `{kit, mode, capabilities, results[], levels, totals, verdict, productionCertified:false, disclaimer}` (ignorado por git). **SKIP** solo por capacidad opcional ausente o decisión humana pendiente; capacidad requerida ausente = FAIL; `NOT_RUN` ⇒ `INCOMPLETE`. Salida: `0` PASS · `1` FAIL · `2` configuración inválida · `3` infraestructura · `4` incompleto.

## 4. Resultados
**MODO A (referencia), una ejecución completa certificada:**
| | Pruebas | PASS | FAIL | SKIP | NOT_RUN |
|---|---|---|---|---|---|
| offline (mundo simulado) | 38 | 38 | 0 | 0 | 0 |
| integrada (EMQX + Mongo + router reales, 1 campaña) | 9 | 9 | 0 | 0 | 0 |
| **total** | **47** | **47** | **0** | **0** | **0** |
Veredicto: **`CONFORMANCE PASS LOCAL (L0-L5)`**. Campaña integrada (misma secuencia que BE13: `D13 → D13b`): 60 eventos F-E2 confirmados con 59 reintentos, 10 normales al primer intento, conflicto terminal, 0 mediciones duplicadas, restart del publisher con outbox idéntico, caída del API sin falso éxito, cross-tenant `not-found`, una sola conexión MQTT.
**MODO B:** preparado y probado con un puente de prueba (no es un publisher): las pruebas independientes del mundo (L0) corren; las que requieren observar/fallar un broker MQTT real quedan `NOT_RUN` (veredicto `INCOMPLETE`, salida 4). No se simuló ninguna ejecución.

## 5. Hallazgos (el kit funcionó como oráculo)
| Sev. | Hallazgo | Resolución |
|---|---|---|
| **MEDIUM** | **`deviceTimestamp`**: medido contra el boundary real, el único valor procesable es un **entero ≥ 0**; strings (incluso ISO), `null`, flotantes y negativos son parseables pero el pipeline los cuarentena. La referencia de BE14-01 los aceptaba (y su vector V6 usaba un string) | referencia corregida (`INVALID_DEVICE_TIMESTAMP`); V6 pasa a entero (hash recalculado en ambos archivos de vectores); regla documentada en el contrato de conformidad |
| **MEDIUM** | la referencia publicaba readings que el parser del backend rechaza (claves en mayúscula/espacios, valores anidados): jamás se confirmarían | `encodeEvent` valida con el **parser real** y rechaza localmente (`INVALID_READING`) |
| LOW | errores del propio kit encontrados y corregidos al diseñar las pruebas: comparación de path sin decodificar `%3A`; mundo que entregaba al backend antes de sembrar cuarentena (el claim gana a la cuarentena); fuga del servidor HTTP del mundo ante un `boot` fallido; `EPIPE` no manejado en el puente | corregidos y cubiertos por tests |
| INFO | el modo externo no puede observar un broker MQTT real todavía | `NOT_RUN` explícito; ticket recomendado |

## 6. Tests y mutantes
`test/be14-03-conformance-kit.test.js` (10: vectores, MODO A completo, semántica de SKIP/FAIL/timeout/infra, MODO B `NOT_RUN`, configuración externa sin secretos, puente stdio con proceso real, CLI y códigos de salida, mapeo integrado, solo-tooling) y `test/be14-03-mutants.test.js` (control + 8): **8/8 publishers defectuosos rechazados por el kit** con código de fallo claro (M1 PUBACK=éxito, M2 retry con nuevo `eventId`, M3 retry con bytes distintos, M4 restart limpia el outbox, M5 `pending` confirma, M6 conflict reintentado, M7 confirmación de otro evento aceptada, M8 descarte silencioso del outbox). Suite estándar 1191 → **1210**; HTTP 13/13.

## 7. Límites
`CONFORMANCE PASS LOCAL` ≠ certificación de producción ni de hardware. El mundo MQTT es simulado en modo A; el modo externo completo requiere un observador MQTT y control de fallos del broker. Valores de política (retry, capacidad) y autenticación siguen siendo decisiones humanas pendientes.

## 8. Siguiente paso recomendado
Cuando exista un publisher real: implementar su puente, ejecutar `--mode external` y completar el mundo MQTT externo (observador + control de fallos del broker) para convertir los `NOT_RUN` en resultados.
