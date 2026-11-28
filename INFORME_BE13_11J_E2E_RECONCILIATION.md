# INFORME BE13-11J — Confirmación end-to-end y reconciliación del publisher

Estado: `LOCAL_LAB_EVIDENCE` / prototipo `TEST_ONLY`. `productionReady=false`. No se cambió la versión ni la configuración de EMQX, no se reabrieron 11F/11H/11I, no se tocó Mongo (solo lecturas), no se modificó `app.ts` ni ninguna ruta productiva, no se habilitó nada en Production.

## Resultado
El mecanismo **detecta y repara** la brecha de F-E2 sin confiar en el PUBACK: en la campaña local, de **60 eventos con PUBACK**, **57 terminaron `CONFIRMED`** con evidencia durable del backend (54 `processed`, 2 `duplicate-confirmed`, 1 `received-durable`), **0 `QUARANTINED`** y **3 `UNCONFIRMED_EXPLICIT`**. Ningún evento se asumió exitoso sin evidencia; ningún reintento generó una segunda medición. Es un PASS del mecanismo de detección (no se exigía 100 %): en el mismo escenario donde 11H/11I observaron 59 eventos sin entrega, la reconciliación recuperó 56 mediante reintento y dejó 3 explícitamente sin confirmar.

Garantía resultante: **at-least-once + procesamiento idempotente + confirmación/reconciliación end-to-end**. No se afirma exactly-once.

## Qué se construyó
| Pieza | Archivo | Rol |
|---|---|---|
| contrato | `src/iot/ingest-confirmation.contracts.ts` | estados, `eventId`, scope, puerto de evidencia |
| servicio | `src/services/ingest-confirmation.service.ts` | decide el estado desde evidencia durable, fail-closed |
| evidencia Mongo | `src/repositories/mongo-ingest-confirmation.evidence.ts` | lecturas majority, solo lectura, filtradas por `realm` + `sourceId` |
| endpoint | `src/routes/ingest-confirmation.routes.ts` | `GET /ingest-confirmations/:eventId`, solo `TEST_ONLY`, no compuesto en `app.ts` |
| loop del publisher | `scripts/be13-11j/publisher-reconciler.ts` | publish → espera → consulta → reintento mismo `eventId`, política inyectable |
Contrato, estados y límites: `CONTRATO_BE13_11J_INGEST_CONFIRMATION.md`. Decisión y alternativa MQTT: `ADR_BE13_11J_E2E_CONFIRMATION.md`.

## Algoritmo de reconciliación
```
para cada eventId:
  intento 1 = publish original (su PUBACK = BROKER_ACCEPTED, solo informativo)
  repetir hasta maxAttempts / maxElapsedMs:
     esperar delay(intento)            # inicial × factor^(n-1), tope maxDelay
     r = confirm(eventId)              # HTTP; error de red o !=200 = backend no responde
     r ∈ {processed, duplicate-confirmed, received-durable}  → CONFIRMED
     r = quarantined                                            → QUARANTINED (no éxito)
     si no → re-publicar con el MISMO eventId y volver a consultar
  presupuesto agotado → UNCONFIRMED_EXPLICIT (ni éxito ni "pérdida" declarada)
```
Política `TEST_ONLY` de la campaña: inicial 2 s, factor 1,5, tope 6 s, 4 intentos, 60 s máx. El default productivo es `BLOCKED`.

## Pruebas offline
23 tests de contrato/servicio/loop/HTTP + 1 de cableado de la campaña + 7 de mutantes. Cubren: contrato, éxito, pending, missing, duplicado, cuarentena, cross-tenant, retry mismo `eventId`, retry agotado, backend no disponible, stale replay, política y desacople. Detalle en `MATRIZ_BE13_11J_SCENARIOS.md`.

## Mutantes
6/6 muertos (M1 PUBACK final, M2 nuevo eventId, M3 cross-tenant, M4 pending=confirmed, M5 duplicado con nueva identidad, M6 agotado=éxito), con control sin mutar limpio. Sobre M5: muta `idempotencyDocumentId` real; la unicidad de la medición en Mongo la garantiza el store de BE13-06, verificado además en la campaña (0 eventos con más de una medición).

## Campaña EMQX (1, sin repetir)
`D13 → D13b` con la configuración histórica. Tras la ventana original (1 propio entregado, 59 no, 60 stale — el mismo patrón de 11H/11I), el publisher reconcilió los 60 eventos con 20 workers contra el router HTTP real y evidencia Mongo real.
- 59 eventos reintentados (99 re-publicaciones), 56 confirmados tras reintento, 1 confirmado al primer intento (`received-durable`).
- Duplicados: 2 `duplicate-confirmed` (el evento llegó dos veces; el backend lo resolvió idempotentemente). Mediciones por `eventId` > 1: **0**.
- Cross-tenant: el dispositivo B preguntó por un evento de A → `not-found` (igual que un inexistente).
- Los 3 sin confirmar (`d13b-7`, `-13`, `-16`) agotaron 4 intentos; en sus reintentos el publisher **no recibió PUBACK** (causa probable: 20 publishers con el mismo `clientId` MQTT en el arnés; no verificado). No se interpreta como pérdida del broker.
- Observación de infraestructura: el proceso terminó con exit 1 por `EMQX_LAB_CONFIG_FAILED_authn_400` al configurar el grupo siguiente, ya fuera del escenario medido; evidencia y aserciones de 11J completas; sin recursos Docker residuales.

## Hallazgos
1. `eventId` sirve como clave de reconciliación (auditoría en el contrato); el scope lo aporta el servidor.
2. El Durable Inbox no tiene `eventId` indexado: la consulta es un escaneo acotado (límite documentado).
3. Las filas de cuarentena sin `sourceId` no son atribuibles a un tenant.
4. Reutilizar un `eventId` con contenido distinto no es distinguible por una consulta solo-`eventId`.
5. El arnés comparte `clientId` entre publishers concurrentes (afectó 3 reintentos).

## Riesgos y lo que sigue bloqueado
- Política de retry, canal (HTTP vs MQTT), autenticación real de publishers y rate limiting de la consulta: **decisión humana pendiente** (fila 72/73).
- Sigue **bloqueado por capacidad del broker** el cierre de F-E2 como garantía del PUBACK: el mecanismo no repara el broker, lo hace observable y recuperable por el publisher.
- Un publisher que no reconcilie (o cuya política siga `BLOCKED`) conserva la brecha.
- Una sola campaña local, una versión de broker.

## Recomendación
Decidir en la fila 72/73: adoptar la reconciliación end-to-end como contrato de publishers (con política de retry aprobada), indexar `eventId` en el inbox, y reservar la evaluación de otro broker/versión solo si el negocio exige no-pérdida sin que el publisher reintente.
