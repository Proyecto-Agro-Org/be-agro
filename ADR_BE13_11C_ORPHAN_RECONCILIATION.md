# ADR BE13-11C — Reconciliación de registros huérfanos del Durable Inbox

Estado: aceptado para el alcance offline/local. Fecha: 2026-11-25.

## Contexto

BE13-11B persiste la entrega verificada antes de procesarla y emite un receipt solo tras releer con `readConcern: majority`. Una escritura puede quedar **ambigua** (por ejemplo `wtimeout` con los secundarios caídos): el llamador no recibe receipt, pero el registro aparece luego en Mongo. Es el riesgo N4. No es pérdida de datos; es un registro durable sin decisión operativa.

## Decisión

1. **El registro crudo no se toca.** Se crea una colección de estado separada (`<prefix>_broker_inbox_state`), un documento por `inboxId`.
2. **Huérfano = registro crudo sin documento de estado**, más antigüedad suficiente según una **política inyectada**. Se prefiere evidencia estructural (marcadores `receipted`/`completed`) a inferencia temporal; el tiempo solo desempata entre "en vuelo" y "abandonado".
3. **La política productiva es BLOCKED.** No se eligió ningún intervalo, antigüedad ni duración de lease. Las pruebas usan valores `TEST_ONLY`.
4. **La antigüedad y el vencimiento de lease se miden con el reloj de la base de datos (`$$NOW`)**, no con el del proceso, para no depender de relojes de nodos de aplicación.
5. **Claim con CAS y fence (token + version)**; takeover solo con lease vencido; completion solo del titular vigente.
6. **Integridad antes de procesar**: se recomputan SHA, contexto y procedencia. `integrity-failed` es pegajoso y no reintentable.
7. **Idempotencia downstream sigue siendo la garantía de "una medición"**; el claim solo acota trabajo duplicado.
8. **Ejecución manual y acotada** (`inspect-only` / `reconcile`, límite explícito). Sin worker, cron, polling ni cambios en `app.ts`.
9. **Marcadores en la admisión opcionales** (`reconciliationStore` inyectado), best-effort: perderlos solo convierte un registro en candidato.
10. **No se reutiliza el lease de cuarentena** de BE13-10B: semántica distinta; se reutiliza solo el patrón.

## Alternativas descartadas

- *Campo `processedAt` en el registro crudo*: obliga a un `update` general sobre evidencia que debe ser inmutable.
- *TTL o borrado de huérfanos*: retención es decisión humana pendiente.
- *Reprocesar sin claim, confiando en la idempotencia*: correcto en datos pero duplica trabajo y oculta la contención.
- *Umbral fijo de antigüedad en producción*: sería inventar una decisión humana.

## Consecuencias

- N4 queda cerrado en la topología local probada (ver informe), no en Atlas/Production.
- Quien programe la reconciliación (worker, manual, al arrancar) sigue pendiente (decisiones 32/33/37).
- Un registro `receipted` que nunca se completó (consumidor caído tras recibir el receipt) **no** es reclamable: pertenece al titular del receipt. Resolver ese caso requiere una decisión humana adicional.
- El barrido recorre la colección cruda por `{realm, rawPersistedAt}` y une por `_id`: con retención indefinida el costo crece; depende de retención/archivado (decisión 29).
