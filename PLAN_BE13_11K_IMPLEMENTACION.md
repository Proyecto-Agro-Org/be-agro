# PLAN BE13-11K — Implementación posterior (no ejecutar en esta etapa)

Estado: **plan propuesto, condicionado a la aprobación humana de las filas 72 y 73.** Ningún ticket está iniciado ni autorizado. Orden por dependencia; cada ticket es pequeño y desacoplado. `productionReady=false` hasta cerrar todos los que apliquen y una revisión de seguridad.

| Ticket | Alcance | Depende de | Fuera de alcance | Criterio de cierre |
|---|---|---|---|---|
| **11L — índice + fingerprint** | campo `eventId` en el registro del inbox (escrito al insertar), índice `inbox_realm_source_event`, `collMod` del validador, backfill acotado/reanudable, lookup directo con fallback temporal para registros sin `eventId`; estado `conflict` por `payloadSha256` (el hash ya existe en el inbox); consulta con `payloadSha256` obligatorio | aprobación fila 73 (indexación y fingerprint) | endpoint HTTP final, auth | lookup directo sin escaneo; tests offline + Mongo real de índice/backfill; 0 falsos `not-found` por ventana; evidencia de plan de ejecución (explain) |
| **11M — endpoint, auth y rate limiting** | endpoint productivo detrás de identidad real de publisher (`principalReference` → `sourceId`), 401/403/429, auditoría de consultas, rotación de credenciales, contrato de cuarentena con ámbito `source`/`principal` + hash (cambio de almacenamiento de cuarentena) | aprobación de auth/tecnología y límites; 11L | integración en el publisher | pruebas cross-tenant, enumeración y límites de tasa; sin exposición de datos ajenos; revisión de seguridad |
| **11N — integración del publisher** | cliente de referencia: outbox acotado, retry de dos carriles con jitter, `UNCONFIRMED` + alertas, offline; **corrección del arnés para usar `clientId` únicos** y una corrida corta que clasifique definitivamente los 3 `UNCONFIRMED` de 11J (`UNVERIFIED_HYPOTHESIS` → resuelta) | aprobación de la política de retry; 11L, 11M | decisión de descarte por saturación del outbox (humana) | campaña local con tasa de confirmación medida; 0 eventos asumidos exitosos sin evidencia; 0 duplicados |
| **11O — comparación de versión de broker (opcional)** | misma secuencia `D13 → D13b` contra otra versión/modo de EMQX, solo evidencia | decisión explícita de querer evaluar C | cambiar de broker, producción | informe comparativo; no sustituye a 11L–11N |

## Orden y paralelismo
11L → 11M → 11N. 11O es independiente y opcional. La corrección del `clientId` del arnés puede adelantarse como mini-ticket si se quiere cerrar antes la duda sobre los 3 `UNCONFIRMED`.

## Decisiones humanas que desbloquean cada ticket
| Ticket | Decisiones requeridas |
|---|---|
| 11L | fila 73: indexación y fingerprint (`payloadSha256` + `conflict`); autorización para cambiar el schema del inbox |
| 11M | fila 73: tecnología de autenticación del publisher, límites de tasa, política de rotación; contrato de cuarentena |
| 11N | fila 73: valores de la política de retry; política de saturación del outbox; quién atiende `UNCONFIRMED` |
| 11O | fila 72: si se desea evaluar la opción C |

## Riesgos del plan
- Migración del inbox (colección con registros retenidos y política de inmutabilidad): ejecutar con ventana y backfill reanudable.
- El contrato v1 cambia la consulta del prototipo (`payloadSha256` obligatorio): los publishers de prueba deben adaptarse.
- Un publisher que no implemente 11N conserva la brecha de F-E2.
