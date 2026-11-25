# INFORME BE13-11C — Auditoría de seguridad

Alcance: reconciliación del Durable Inbox y contrato del adapter. Offline y MongoDB local desechable. Sin EMQX ni credenciales.

## Superficie revisada

1. Estado operativo separado del registro crudo (inmutable).
2. Claim/CAS/fencing sobre el estado.
3. Integridad antes de procesar.
4. Aislamiento por realm en store, scan, claim y servicio.
5. Reportes: audit, métricas, alertas, informes.
6. Frontera con el adapter (hechos observados frente a autoridad).
7. Política de reconciliación (BLOCKED por defecto).

## Hallazgos de este ciclo

| ID | Severidad | Hallazgo | Estado |
|---|---|---|---|
| N4 | Medio (heredado) | Escritura ambigua del inbox deja un registro durable sin receipt ni decisión operativa. | **CERRADO** (ver informe). |
| F1 | Medio | El primer mutante de fencing (`complete` sin token/versión) **sobrevivió** a la campaña: no se probaba una completion stale mientras el estado seguía `claimed`. | Corregido: C10b; el mutante ahora muere. |
| F2 | Bajo | Un fallo no reproducido de C11 antes de instrumentar (1 de 6). Causa no demostrada; hipótesis: carrera del harness. | Harness corregido y instrumentado; 3/3 y corridas finales verdes. Residual documentado. |
| F3 | Bajo | En la admisión, los marcadores `receipted`/`completed` son best-effort: perderlos convierte un registro en candidato. | Aceptado: la reconciliación es idempotente (R23). |
| F4 | Bajo | Un primer bug del claim de takeover (respuesta `null` del driver tratada como objeto) apareció en la primera corrida real. | Corregido; detectado por C03. |
| N1 | Medio | Reloj del adapter adelantado frente al de la base ⇒ `invalid-timestamp`. | **OPEN / BLOCKED_BY_POLICY**. |

## Riesgos residuales

- El adapter es parte del TCB: puede mentir sobre hechos observados.
- Los fingerprints son SHA-256, no MAC: quien reescriba un registro completo de forma consistente no es detectado.
- La procedencia no se revalida al reconciliar (revocación, decisión 31).
- Un registro `receipted` cuyo consumidor murió no es reclamable.
- El barrido crece con el inbox (retención indefinida).
- La estabilidad de C11 es de la topología Docker local, no de Atlas.
- Fingerprints/claims no protegen frente a un administrador de Mongo.

## Verificaciones negativas

Sin `process.env`, temporizadores, bucles, `deleteOne`/`deleteMany`/`replaceOne`, TTL, referencias MQTT/EMQX en el código nuevo (A16); `app.ts` sin cambios; sin dependencias MQTT en `package.json`; `productionReady` permanece `false`.

## Secret scan

Ver informe: sin hallazgos (no se imprime ningún valor).
