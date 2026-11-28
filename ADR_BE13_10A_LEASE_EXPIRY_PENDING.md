# ADR BE13-10A — Expiración de leases de replay (PENDIENTE)

## Estado

**Pendiente de decisión humana.** No se fija duración ni se activa expiración.

## Contexto

BE13-09 introdujo el lease `REPLAYING` (CAS). Un lease huérfano no expira, y `releaseLease` no distingue un lease huérfano de uno en uso (S7). Liberar un lease en uso y luego descartar puede dejar una medición de una entrada descartada.

## Decisión técnica tomada

1. Contrato `ReplayLeasePolicy` + `OperationsTimeAuthority` + `ReplayLeaseStore` + governor.
2. `EXPIRED` es derivado (tiempo confiable + decisión de la política) y nunca se asume.
3. Propiedad probada por la identidad autenticada; el `leaseId` no autentica.
4. Recuperación = liberar y luego adquirir, cada paso con CAS y autorización. Sin takeover silencioso.
5. Defaults: el lease nunca expira y el tiempo no es confiable. Solo el dueño libera.
6. Sin cambios de esquema Mongo en BE13-10A.

## Decisiones pendientes

| Pregunta | Impacto |
| --- | --- |
| Duración del lease (o criterio no temporal, p. ej. heartbeat) | cuándo un replay colgado puede recuperarse |
| ¿Puede un no-dueño recuperar? ¿Con qué capacidad? | SoD y capacidad dedicada (`QUARANTINE_LEASE_RECOVER`, hoy inexistente) |
| Autoridad temporal aprobada | sin ella nada expira |
| ¿Qué pasa con un replay que termina tras perder el lease? | hoy la medición puede persistir (idempotente); la transición final falla por CAS |

## Para cerrar S7 en runtime (BE13-10B, tras decidir)

Persistir `leaseOwner` y `leaseAcquiredAt` en la cuarentena (migración de esquema con validator), hacer que el replay de BE13-09 adquiera el lease con el governor y que `releaseLease` delegue en él, y repetir la campaña Mongo de concurrencia (O11–O13 + recuperación).
