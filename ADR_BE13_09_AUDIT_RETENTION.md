# ADR BE13-09 — Retención del audit operativo

## Estado

Aceptado sin valor productivo: la retención real es **decisión humana pendiente**.

## Contexto

La auditoría embebida de BE13-08 estaba acotada a 100 entradas por cuarentena. BE13-09 la saca a una colección append-only propia. Cuánto conservarla depende de requisitos legales, contractuales y de costo que el equipo técnico no puede fijar.

## Decisión

1. **Sin índice TTL** y sin borrado programado: no se inventa un plazo.
2. Política explícita inyectada: `AuditRetentionPolicy = { mode: 'retain-indefinitely' } | { mode: 'pending-decision' }`.
   - `pending-decision` → readiness `BLOCKED` (`operationsTestReady = false`).
   - `retain-indefinitely` → `INJECTED_UNVERIFIED` (aceptable para pruebas, no es una aprobación).
3. La limitación `AUDIT_RETENTION_PRODUCTION_PENDING` aparece siempre en readiness.
4. **No se afirma WORM**. El store no tiene update/delete, pero Mongo no impide que una cuenta con privilegios de escritura altere documentos.

## Alternativas descartadas

- TTL de N días: plazo arbitrario y posible pérdida de evidencia legal.
- Capped collection: descarta lo más antiguo silenciosamente.
- Afirmar inmutabilidad: falso sin controles de cuentas, Atlas o almacenamiento externo con retención bloqueada.

## Consecuencias

El volumen crece sin límite hasta que se decida la retención. La contención del contador por stream es baja por cuarentena y mayor en el stream `realm`.

## Decisiones humanas pendientes

Plazo de retención por tipo de acción; legal hold; archivado o exportación; quién puede leer el audit (`AUDIT_VIEW`); si se requiere inmutabilidad real (WORM) y con qué mecanismo.
