# INFORME BE13 — Cierre técnico final del Paso 13

Estado: **BE13 técnicamente cerrado en modo local/`TEST_ONLY`. `productionReady=false`** (decisiones humanas y de producto pendientes, ver §8). Semántica del sistema: **at-least-once + procesamiento idempotente + almacenamiento durable + reconciliación end-to-end**. No se afirma exactly-once.

## 1. Git del ciclo 11L → FINAL
| | |
|---|---|
| `dev` inicial / final | `13abf17` → ver PR final (`BE13-FINAL`) |
| `main` inicial / final | `1bb20f7` → `1bb20f7` (**intacto**) |
| PRs | #43 11L (`6ccf893`) · #44 11M (`50f6a38`) · #45 11N (`bbbb0b7`) · #46 11P (`1b447bb`) · #47 11Q (`a55fcdf`) · FINAL |
| Estado del repo | local: `main`, `dev`; remoto: `origin/main`, `origin/dev`; un worktree; árbol limpio |
| Atlas / Production | no se tocaron; todo Mongo fue local descartable |

## 2. Etapas y por qué fueron necesarias
| Etapa | Pregunta / gap | Resultado |
|---|---|---|
| **11L** | el lookup escaneaba hasta 5000 filas; `eventId` reutilizado daba falso éxito | `eventId` + índice en el inbox, `payloadSha256`, estado `conflict`, fallback legacy acotado, migración dry-run por defecto. EXPLAIN: IXSCAN, 1 clave/1 doc vs 800/800. 15 tests, mutantes 5/5 |
| **11M** | auth/rate limiting/hardening de la API; cuarentena sin `sourceId` no reconciliable | router factory con auth y rate-limit `BLOCKED` por defecto, ajeno≡inexistente, validación estricta; cuarentena nueva guarda principal+hash+eventId declarado (ALS); upgrade local. 18 tests, mutantes 6/6; Mongo real: dueño ve `quarantined`, otros no |
| **11N** | publisher sin outbox, colisión de `clientId` | outbox durable (archivo atómico), retry de dos carriles, saturación explícita, una conexión por identidad. Campaña D13→D13b: **60/60 CONFIRMED**, 59 reintentados, 0 duplicados, crash/restart idéntico. 24 tests, mutantes 8/8 |
| **11O** | ¿comparar versión de broker? | **no ejecutada** — `OPTIONAL / FUTURE`: la reconciliación E2E cumple el objetivo funcional sin cambiar el broker |
| **11P** | observabilidad mínima inexistente para el nuevo camino | métricas cerradas, logs por allowlist, correlación (sourceId,eventId), umbrales candidatos. 6 tests |
| **11Q** | el camino `pending` solo estaba probado con dobles | Mongo real sin mayoría: evento durable sigue confirmable, evento escrito durante la pérdida nunca se confirma, sin primario `pending` acotado (4 s); publisher converge tras el heal. **Fix**: lecturas de evidencia acotadas. 1 test + 5/5 en campaña |
| **11R / 11S / 11T** | migración / seguridad / contratos | **no necesarias como etapas**: migración ensayada en 11L/11M (runbook abajo); seguridad cubierta por 11M; contrato consolidado en este cierre (`CONTRATO_BE13_RECONCILIACION_E2E.md`) |
| **FINAL** | auditoría y cierre | sin código muerto relevante, sin dependencias nuevas, sin secretos, defaults `BLOCKED` verificados por test, 6 tests de cierre |

## 3. Matriz de cierre (20 áreas)
| Área | Estado final | Evidencia | Riesgo residual |
|---|---|---|---|
| 1 broker durability | `BLOCKED_BY_BROKER_CAPABILITY` (mitigado a nivel sistema) | 11F/11H/11I (`SESSION_STATE_LOSS_LOCAL`), 11N | EMQX 5.8.6 CE puede no entregar tras restart con historial; la reconciliación lo detecta y repara, no lo arregla |
| 2 durable inbox | `CLOSED_LOCAL` | 11B/11G/11L; majority + journal | retención del inbox (decisión humana) |
| 3 idempotencia | `CLOSED_LOCAL` | BE13-06 real Mongo (M10/M12b), 11J/11N: 0 mediciones duplicadas | — |
| 4 event identity | `CLOSED_LOCAL` | clave `(realm,sourceId,eventId)` + `payloadSha256`; 11L | `eventId` lo elige el publisher |
| 5 publisher reconciliation | `CLOSED_LOCAL` | 11J, 11N (60/60), 11Q | requiere que el publisher real la implemente |
| 6 outbox durability | `CLOSED_LOCAL` | 11N: archivo atómico, crash/restart idéntico | persistencia real en el dispositivo (decisión humana) |
| 7 retry semantics | `CLOSED_LOCAL` / valores `PENDING_HUMAN_DECISION` | 11J/11N, mutantes | política aprobada |
| 8 conflict detection | `CLOSED_LOCAL` | 11L, 11N | — |
| 9 tenant isolation | `CLOSED_LOCAL` | 11M matriz, ajeno≡inexistente, cuarentena por principal | — |
| 10 quarantine attribution | `CLOSED_LOCAL` (filas nuevas) | 11M real Mongo | cuarentenas legacy sin `sourceId` siguen no reconciliables |
| 11 authentication | `BLOCKED_BY_POLICY` | auth `BLOCKED`; tecnología sin elegir | endpoint no componible hasta decidir |
| 12 rate limiting | abstracción `CLOSED_LOCAL`; valores `PENDING_HUMAN_DECISION` | 11M | límites aprobados |
| 13 migration readiness | `CLOSED_LOCAL` (ensayada) / ejecución real `PENDING_HUMAN_DECISION` | 11L, 11M; runbook §9 | migración *roll-forward only* |
| 14 observability | `CLOSED_LOCAL` (contrato) | 11P | sin exportador/dashboards; umbrales candidatos |
| 15 crash recovery | `CLOSED_LOCAL` | 11N (publisher), 11F–11J (broker/consumer/Mongo), 11Q (pérdida de mayoría) | crash del proceso del backend de confirmación: stateless |
| 16 duplicate safety | `CLOSED_LOCAL` | 11J/11N/11L | — |
| 17 publisher collisions | `CLOSED_LOCAL` | 11N: `clientId` = identidad, una conexión por identidad | — |
| 18 API contract | `CLOSED_LOCAL` | `CONTRATO_BE13_RECONCILIACION_E2E.md` | cambios futuros requieren versionado |
| 19 documentation | `CLOSED` | este informe + contrato + ADR/informes por etapa | — |
| 20 operational readiness | `PENDING_HUMAN_DECISION` | runbook §9, alertas candidatas | ownership de `UNCONFIRMED`, on-call, retención |

## 4. Arquitectura final
publisher (outbox durable + retry de dos carriles + una conexión por identidad) → broker EMQX (PUBACK = `BROKER_ACCEPTED`) → adapter/boundary (verificación de procedencia, `declared.eventId`, hash de bytes) → **Durable Inbox** (registro crudo + `eventId` + `rawPayloadSha256`, majority + journal) → procesamiento idempotente (claim + medición en una transacción) / cuarentena (con ámbito reconciliable) → **API de confirmación** (lecturas majority acotadas; estados por evidencia) ← publisher (consulta, reintenta con el mismo `eventId`, termina en `CONFIRMED`/`QUARANTINED`/`CONFLICT`/`UNCONFIRMED_EXPLICIT`).

## 5. Qué garantiza y qué NO
**Garantiza (local):** un evento solo se considera exitoso con evidencia durable del backend; los PUBACK, `pending`, `not-found`, timeouts, errores y estados desconocidos nunca son éxito; reintentos con el mismo `eventId` y bytes; una medición lógica por evento aunque se reentregue; aislamiento por ámbito autenticado; el publisher no pierde en silencio (saturación y agotamiento son estados explícitos).
**No garantiza:** exactly-once; que el broker entregue (F-E2 sigue `BLOCKED_BY_BROKER_CAPABILITY`); que un publisher que no reconcilie esté a salvo; autenticación productiva; valores aprobados de retry/rate limit; reconciliación de cuarentenas anteriores a 11M sin `sourceId`.

## 6. F-E2 (separado)
- **Garantía del broker:** `BLOCKED_BY_BROKER_CAPABILITY` (EMQX 5.8.6 CE: estado de sesión/inflight no sobrevive con fidelidad; PUBACK anterior a la escritura durable).
- **Mitigación a nivel sistema:** reconciliación E2E obligatoria (11J–11N–11Q): sobre la misma secuencia que perdía 59 de 60, el publisher con outbox terminó con **60/60 `CONFIRMED`**.

## 7. Mongo
Inbox: `eventId` opcional (validador evolucionado) + índice `inbox_realm_source_event` `{realm,sourceId,eventId,rawPersistedAt:-1}` (no único). Cuarentena: `principalReference`, `payloadSha256`, `declaredEventId` opcionales + índice `quarantine_realm_principal_event`. Idempotencia: sin cambios (`{realm,sourceId,operation,eventId,field}` único). Scripts: `scripts/be13-11l/inbox-eventid-migration.ts` (dry-run por defecto; apply solo loopback + `AGRO_MIGRATION_ENABLE=LOCAL_DISPOSABLE_ONLY`; Atlas prohibido) y `upgradeQuarantineScopeBe1311m`.

## 8. Decisiones humanas (no tomadas)
| Técnicamente resuelto (local) | Requiere aprobación humana |
|---|---|
| contrato, estados, outbox, retry, conflicto, aislamiento, observabilidad (contrato), migración ensayada | **fila 72** (adoptar reconciliación E2E obligatoria); **fila 73**: canal HTTP, tecnología de **auth**, valores de **retry** (rápido/lento), **política de saturación** del outbox, **rate limits**, **ejecución de la migración real** (validador + índice + backfill + upgrade de cuarentena), **ownership de `UNCONFIRMED`**, **alternativa de broker (11O)**, retención del inbox, persistencia real del outbox en dispositivo, composición productiva del endpoint |
Ninguna fila está `DECIDED`.

## 9. Runbook de migración (orden obligatorio) y rollback
1. Ensayar `--dry-run` sobre una copia; revisar `unbackfillable`.
2. **Upgrade del validador de cuarentena** (`upgradeQuarantineScopeBe1311m`) **antes** de desplegar código que escriba los campos nuevos (el validador viejo los rechaza).
3. Inbox: `collMod` + índice (`--apply`, solo con autorización humana y en la ventana definida) **antes** del código que escribe `eventId`.
4. Desplegar el backend (lookup con fallback legacy activo).
5. Backfill por lotes; verificar conteos; opcionalmente `legacyScan:false`.
6. **Rollback:** *roll-forward only*. Con registros que ya llevan `eventId`, el código anterior (esquemas estrictos) los rechazaría; revertir exige un `$unset` manual de `eventId`/campos de cuarentena. No hay rollback automático.

## 10. Tests y mutantes del ciclo
Suite: **1074 → 1144** (+70: 11L 15, 11M 18, 11N 24, 11P 6, 11Q 1, FINAL 6). HTTP de regresión 13/13 en cada etapa. Mutantes nuevos del ciclo: 11J 6 + 11L 5 + 11M 6 + 11N 8 = **25/25 muertos**, cada uno con control sin mutar limpio. Campañas locales: 11J (EMQX), 11L (Mongo), 11M (Mongo), 11N (EMQX), 11Q (Mongo) — una por etapa.

## 11. Findings del ciclo
| Sev. | Hallazgo | Estado |
|---|---|---|
| MEDIUM | falso éxito por `eventId` reutilizado (consulta solo por `eventId`) | resuelto (11L) |
| MEDIUM | lectura de evidencia sin cota ante pérdida de primario | resuelto (11Q) |
| MEDIUM | `clientId` compartido: el `clientId` es la identidad del dispositivo | resuelto (11N: una conexión por identidad) |
| LOW | lookup del inbox por escaneo | resuelto (11L) |
| INFO | cuarentenas legacy sin `sourceId`; migración roll-forward only; `received-durable` cuenta como confirmado; confirmación sin registro de inbox ⇒ `pending` | documentado |
| INFO | el `authn_400` esporádico del arnés de 11J no reapareció (no diagnosticado) | abierto, sin impacto funcional |

## 12. Infra
Sin contenedores ni redes del ciclo; red histórica `agro-mn-ce918806…` y 331 volúmenes anónimos intactos. Recursos de cada campaña limpiados por el lanzador.

## 13. Próximo paso
Fuera de BE13: obtener las decisiones humanas de §8 (empezando por fila 72/73 y auth) y abrir un ticket de integración con el publisher real/firmware.
