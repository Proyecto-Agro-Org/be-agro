# MATRIZ BE13-11C — Vectores adversariales

| Vector | Intento | Defensa | Evidencia |
|---|---|---|---|
| Realm falsificado | Llamar al store/claim/scan con otro realm | El store está atado a un realm; todo filtro lo incluye; el reconciliador exige realm = admisión | A01, A08, R03, C06 |
| Estado falsificado | Inventar ids/estados o marcar completado sin claim | API cerrada; ids validados `^ib_[0-9a-f]{32}$`; `complete` exige claim vigente | A02, A04 |
| Token/versión stale | Completar con un fence viejo | CAS por `(status, token, version)` | A03, R05, C10, C10b |
| Doble completion | Dos completions simultáneas | Una sola gana | A07 |
| Doble claim | 2 y 10 reconciliadores | Primer claim por upsert contra `_id` (E11000 pierde) | R06, R07, C03, C08, C09 |
| Manipulación de bytes | Cambiar `rawPayload`/hash/contexto | Se recomputan SHA, contexto y procedencia antes de procesar | A05, R08, C07 |
| Manipulación de procedencia | Cambiar verifiedAt, revisiones, sourceId, principal | `provenanceFingerprint` | A06 |
| Reproceso | Procesar algo ya procesado | Idempotencia BE13-06; resultado `already-processed` | R09, R23, C12 |
| Reintento de integridad | Insistir en un registro adulterado | `integrity-failed` pegajoso | R08, C07 |
| Respuesta maliciosa del store | Claim ajeno, formas inválidas, `complete` truthy | Validación Zod estricta y `=== true` | A09 |
| Fuga de payload | Payload/topic/ids en audit, métricas, alertas | Reportes sin esos campos; audit del reconciliador sin eventId | A10, R13, C15, C16 |
| Adapter con clientId de negocio | Enviar identidad de negocio | Delivery cerrado + mapping autorizado | A11, R17 |
| Adapter con `trusted`/`verified` | Enviar banderas de autoridad | Delivery cerrado: `broker-context-malformed` | A12 |
| Realm desde el topic | Topic con `production` | El realm sale del bootstrap | A13, R18 |
| Principal falso | Principal desconocido o `null` | Verifier + mapping; no se persiste | A14 |
| `packetId` como identidad | Usarlo de clave | Nunca se usa; ids de inbox aleatorios | A15 |
| Política productiva implícita | Reconciliar sin política decidida | BLOCKED por defecto | R21, extra Mongo |
| Barrido ilimitado | Scan sin tope | Límite explícito 1..500 y `maxBatch` | R16, C14 |
| Worker/cron encubierto | Bucle o temporizador | Prueba estructural | A16 |
| Payload nuevo en el reconciliador | Pasar bytes alternativos | La firma no acepta payload | A17 |
| Reloj adelantado del adapter | `receivedAt` > `rawPersistedAt` | BE13-02 rechaza fail-closed; sin tolerancia | R25, R27–R31 |
