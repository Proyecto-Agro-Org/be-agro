# BE-13 — Plan incremental de integración

Base reconciliada: `dev` en `6a30be4374e68f655ef31fbb69286f4b5ab48178`, con BE-11 y BE-12 integrados. Este plan conserva estados propuestos; no aprueba contratos productivos ni habilita conexiones externas.

Ninguna tarea de este plan fue implementada durante BE-13A.

| ID | Objetivo | Repo | Dependencias | Riesgo | Pruebas y aceptación | Offline | Aprobación externa |
|---|---|---|---|---|---|---|---|
| BE13-01 | Obtener fixtures sanitizados y congelar contrato EMQX → ingesta | iot-ingest/docs | IoT/broker | alto: contrato ficticio | fixtures por tipo, retries, null/cero, bytes y timestamps; revisión IoT | parcial | SÍ: IoT/EMQX |
| BE13-02 | Implementar parser/mapper puro de documento protegido a candidato no atribuido | be-agro | BE13-01 | alto: conceder confianza indebida | Zod estricto; rechaza tenant/autoridad pública; conserva raw/timestamps; no I/O | SÍ | contrato BE/IoT |
| BE13-03 | Resolver `sourceId + TechnicalDeviceKey` mediante puerto BE-11 | be-agro | BE13-02, catálogo dispositivo | crítico: cruce de clientes | unknown/duplicate/unverified/inactive; dos fuentes; sin fallback | SÍ con adapters | SÍ: autoridad hardware |
| BE13-04 | Aprobar e implementar política temporal | be-agro | fixtures reales | crítico: atribución histórica incorrecta | half-open, atraso, deep sleep, skew, A→B→A, cuarentena | SÍ inicialmente | SÍ: IoT/BE |
| BE13-05 | Aprobar catálogo de magnitudes/unidades y mapper de payload | be-agro | BE-04 + fixtures | alto: conversión falsa | null≠0; unidad desconocida; parciales; procedencia; S8 sin NPK/pH | SÍ | SÍ: Agronomía/IoT/FE |
| BE13-06 | Implementar repository Mongo de mediciones en namespace aislado | be-agro | mapeo físico aprobado | alto: esquema/índices incompatibles | BSON, índices, eventId único, tenant/time filters, concurrency, rollback | SÍ con Docker | SÍ: DB/Atlas mapping |
| BE13-07 | Componer modo protegido de ingesta sin activar Production | iot-ingest | EMQX sandbox, secretos, namespace | crítico: interrumpir servicio | auth, rotación, ACK, retries, rollback, health; legacy sin fallback 401 | parcial | SÍ: Ops/Security |
| BE13-08 | Cerrar OpenAPI BE-11/12 y adapter frontend | be-agro + fe-agro | IDs, fechas, catálogo | medio/alto: ruptura FE | contract tests, error envelope, cursor, máximo, vacíos y nulls | SÍ | SÍ: FE/BE |
| BE13-09 | Validar integración en Preview aislado | 3 repos | 01–08 | crítico: tocar Production | ramas/variables aisladas, base descartable, smoke read-only, sin promoción | NO | SÍ: Vercel/DB/Ops |
| BE13-10 | E2E Hardware/EMQX controlado | 3 repos | sandbox completo | crítico: identidad/replay | publicación real controlada, retry, duplicado, atraso, A/B y UI | NO | SÍ: IoT/Ops/QA |
| BE13-11 | Plan de corte, observabilidad y rollback | iot-ingest + be-agro | E2E aprobado | crítico: pérdida/doble escritura | runbook, métricas sin payload, rollback sin degradar auth, respaldo | parcial | SÍ: equipo completo |

## Secuencia recomendada

1. **Contrato antes que conexión:** BE13-01.
2. **Transformación fail-closed offline:** BE13-02 y BE13-03.
3. **Decisiones de dominio:** BE13-04 y BE13-05.
4. **Persistencia real aislada:** BE13-06.
5. **Activación técnica en sandbox:** BE13-07.
6. **Contrato de lectura y frontend:** BE13-08.
7. **Preview y E2E externos:** BE13-09 y BE13-10.
8. **Corte productivo separado:** BE13-11 y autorización posterior específica.

## Primera tarea recomendada

BE13-01 debe abrirse como tarea documental conjunta con IoT. El entregable mínimo es un paquete de fixtures sanitizados firmado por versión del contrato, con explicación de la autoridad de cada campo. Mientras falte, BE13-02 puede preparar interfaces y casos negativos, pero no aprobar el mapper positivo definitivo.
