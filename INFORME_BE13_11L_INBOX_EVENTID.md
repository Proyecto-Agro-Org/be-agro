# INFORME BE13-11L — Durable Inbox con `eventId`, `payloadSha256`/`conflict` y lookup indexado

Estado: `LOCAL_LAB_EVIDENCE`. `productionReady=false`. Mongo solo local/descartable; sin Atlas; la migración se ensayó en una colección sintética (dry-run por defecto).

## Qué cambió
| Área | Cambio |
|---|---|
| Inbox (nuevas escrituras) | el registro guarda `eventId` (el `declared.eventId` ya validado por el boundary). El store **rechaza** (`INBOX_EVENTID_MISMATCH`) un `eventId` que no sea el contenido en los bytes que persiste. Legacy: sin `eventId` (nunca se inventa); `InboxRecord.eventId` es `string \| null` |
| `payloadSha256` | se reutiliza `rawPayloadSha256` del inbox (SHA-256 de los bytes crudos exactos, verificado por el store antes de escribir). La consulta de confirmación exige el hash que el publisher calcula sobre los bytes que publicó |
| `conflict` | mismo `(realm, sourceId, eventId)` con **otro** hash (o hashes mezclados) ⇒ estado `conflict`, no confirmante, sin revelar el hash almacenado. Mismo hash repetido = reintento legítimo (`duplicate-confirmed`). Un claim sin registro de inbox no se puede atar a los bytes ⇒ `pending` |
| Lookup | directo por `{realm, sourceId, eventId}` (índice `inbox_realm_source_event {realm,sourceId,eventId,rawPersistedAt:-1}`, no único) + **fallback acotado solo para registros legacy sin `eventId`** (`legacyScan`, por defecto activo) |
| HTTP | `GET /ingest-confirmations/:eventId?payloadSha256=<hex64>`: el hash es obligatorio (400 si falta/inválido) |
| Migración | `scripts/be13-11l/inbox-eventid-migration.ts`: **dry-run por defecto**; `--apply` exige `AGRO_MIGRATION_ENABLE=LOCAL_DISPOSABLE_ONLY` y URI loopback (Atlas/hosts remotos prohibidos); pasos idempotentes: `collMod` del validador, índice, backfill solo de legacy con hash probado y `eventId` válido; nunca borra ni modifica los campos de evidencia cruda |

## Evidencia (campaña local única, `.local-evidence/be13-11l-index.json`)
| Prueba | Resultado |
|---|---|
| seed por el store real: 2 tenants × 400 registros, mismos `eventId` en ambos | 800 con `eventId` |
| `eventId` falsificado respecto de los bytes | rechazado, 0 registros |
| índices de la colección aprovisionada | `inbox_realm_persisted`, `inbox_realm_source_event` |
| **EXPLAIN del lookup directo** | `LIMIT → FETCH → IXSCAN:inbox_realm_source_event`; **1 clave, 1 documento examinado** (sin COLLSCAN ni SORT en memoria) |
| mismo dataset con el escaneo previo (`{realm, sourceId}` limit 5000) | 800 claves / 800 documentos |
| semántica de confirmación sobre el inbox real | `received-durable` + `match`; retry mismo hash ⇒ `deliveries=2`; hash distinto ⇒ `conflict`; mismo `eventId` con bytes distintos en el mismo tenant ⇒ `conflict`; inexistente ⇒ `not-found`; cada tenant solo ve lo suyo |
| migración sobre colección legacy (validador viejo, 7 registros) | dry-run: 3 backfillables, 4 no (`payload-not-json`, `eventid-missing`, `hash-mismatch`, `eventid-invalid`), 3 propuestas, **0 escrituras**; apply: `collMod` + índice + 3 backfills; evidencia cruda intacta; re-ejecución idempotente (0); lookup directo IXSCAN tras migrar; un registro nuevo con `eventId` se acepta tras el `collMod` |
| compatibilidad legacy antes de migrar | el fallback encuentra el registro legacy |

## Tests y mutantes
`test/be13-11l-inbox-eventid.test.js` (9) y `test/be13-11l-mutants.test.js` (control + 5): M1 hash distinto no es conflicto, M2 retry legítimo marcado conflicto, M3 el lookup directo pierde el scope de tenant, M4 legacy ignorado, M5 la migración aplica por defecto. **5/5 muertos**, control limpio. Los tests de 11J se adaptaron al contrato con hash.

## Findings
| Sev. | Hallazgo |
|---|---|
| MEDIUM (resuelto) | una consulta solo por `eventId` daba `processed` por el primer contenido (falso éxito con `eventId` reutilizado): ahora exige `payloadSha256` y devuelve `conflict` |
| LOW (resuelto) | el escaneo del inbox crecía con el volumen de otros tenants: reemplazado por lookup directo |
| INFO | el backfill escribe `eventId` en registros históricos (única excepción a "insert-only"); queda restringido a legacy con hash probado y solo en entornos locales; ejecutarlo en datos reales es una decisión humana |
| INFO | la cuarentena sigue sin ámbito reconciliable para escrituras antiguas (11M) |

## Decisiones humanas
Autorización para evolucionar el validador del inbox y ejecutar el backfill en datos reales (fila 73). Nada se aplicó fuera de colecciones locales descartables.
