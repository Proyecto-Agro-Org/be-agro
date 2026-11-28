# ADR BE13-10A — Retención del audit y legal hold (PENDIENTE)

## Estado

**Pendiente de decisión humana.** No se fija plazo, no hay TTL y nada se borra.

## Contexto

BE13-09 guarda el audit operativo en una colección append-only sin TTL (`ADR_BE13_09_AUDIT_RETENTION.md`). Falta decidir cuánto conservar, cuándo un registro puede revisarse para borrado y cómo se aplica un legal hold.

## Decisión técnica tomada

1. `AuditRetentionAuthority` por stream con modos `pending-decision`, `retain-indefinitely` y `retain-until` (con referencia de aprobación).
2. `LegalHoldAuthority`: el hold se evalúa primero y gana siempre. Un hold desconocido equivale a retener.
3. La evaluación devuelve `RETAIN` o `ELIGIBLE_FOR_DELETION_REVIEW`, con `deletes: false`. No existe método ni proceso de borrado.
4. Defaults: retención pendiente y legal hold activo.
5. **WORM no se afirma ni se implementa**: requiere almacenamiento o controles externos.

## Decisiones pendientes

Plazo por tipo de acción o realm; requisitos legales o contractuales aplicables; quién impone y levanta un legal hold; proceso de revisión y ejecución de borrado (si existe); archivado o exportación; WORM real (mecanismo y proveedor); acceso de lectura (`AUDIT_VIEW`).

## Consecuencias

El audit crece sin límite hasta decidir. Ningún componente puede borrar registros.
