# BE-13 — Matriz de decisiones humanas pendientes

Ninguna opción está seleccionada. Los responsables son **sugerencias de rol**, no asignaciones. Estado común: **PENDIENTE**.

| # | Decisión | Opciones (sin preferencia) | Impacto | Riesgo si se decide mal | Qué bloquea | Evidencia necesaria | Responsable sugerido | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Proveedor de identidad de operadores | IdP corporativo OIDC/SAML · IdP gestionado · propio · reutilizar auth de la app | Quién puede operar cuarentenas | Acceso indebido; dependencia de un proveedor | Toda operación de cuarentena fuera de pruebas | Inventario de cuentas, requisitos de MFA/offboarding, costo, residencia | Responsable de seguridad + líder técnico | PENDIENTE |
| 2 | Roles y mapeo a capacidades | Grupos del IdP → capacidades · roles internos · por persona | Qué hace cada operador | Privilegios excesivos | `OperatorCapabilityMappingPolicy` | Lista de funciones operativas reales | Dueño del producto + seguridad | PENDIENTE |
| 3 | Separación de funciones | Exclusiones estáticas (p. ej. UNBLOCK/DISCARD) · SoD dinámico por entrada · ninguna | Fraude/error de un solo operador | Bloqueo operativo o controles insuficientes | `SeparationOfDutiesPolicy` | Análisis de riesgo por operación; tamaño del equipo | Seguridad + operaciones | PENDIENTE |
| 4 | Expiración de leases de replay | Duración fija · heartbeat · sin expiración (solo dueño) · capacidad de recuperación dedicada | Recuperación de replays colgados; cierre de S7 | Doble procesamiento o entradas bloqueadas | `ReplayLeasePolicy`, migración de cuarentena | Duración observada de replays; SLO de recuperación | Líder técnico + operaciones | PENDIENTE |
| 5 | Retención del audit | Indefinida · hasta fecha por tipo/realm · archivado externo | Costo de almacenamiento; evidencia disponible | Pérdida de evidencia o retención ilegal | `AuditRetentionAuthority` | Requisitos legales/contractuales | Legal + dueño del producto | PENDIENTE |
| 6 | WORM y legal hold | Almacenamiento con retención bloqueada · controles de cuentas en Mongo · export firmado por un tercero · sin WORM | Inmutabilidad demostrable | Alteración no detectable del audit | `LegalHoldAuthority`; afirmaciones de inmutabilidad | Requisitos de cumplimiento; proveedor posible | Legal + seguridad | PENDIENTE |
| 7 | Verificación de evidencia | Validación manual por un segundo operador · integración con sistema de tickets · sin verificación | Confianza en unblock/resolve/discard | Resoluciones sin respaldo | `ResolutionEvidenceVerifier`; exigir `VERIFIED` en resolve | Sistema de tickets/aprobaciones existente | Operaciones + seguridad | PENDIENTE |
| 8 | Clock (reloj de la medición) | received-at · device timestamp con tolerancia · servidor | Orden y validez temporal | Datos fuera de orden o descartados | Clock policy (BLOCKED) | Características reales del hardware | Dueño del producto + hardware | PENDIENTE |
| 9 | `declaredAt` | Device timestamp · received-at · ausente | Qué fecha se informa al cliente | Fechas engañosas | declaredAt policy | Ídem 8 | Dueño del producto | PENDIENTE |
| 10 | `missingReason` | Vocabulario de razones · ausente | Interpretación de huecos | Huecos mal explicados | missingReason policy | Casos reales de datos faltantes | Dueño del producto | PENDIENTE |
| 11 | `persistedAt` | Tiempo de servidor Mongo · tiempo de la app | Trazabilidad | Auditoría temporal inconsistente | persistedAt policy | Requisitos de trazabilidad | Líder técnico | PENDIENTE |
| 12 | Catálogo de magnitudes/unidades | Catálogo BE-04 versionado · catálogo por cliente | Qué mediciones se aceptan | Unidades erróneas | Catálogo (BLOCKED) | Lista aprobada de sensores y unidades | Dueño del producto + agronomía | PENDIENTE |
| 13 | Atestación de hardware | Certificados por dispositivo · registro manual · sin atestación | Confianza en el origen | Dispositivos suplantados | Hardware attestation (BLOCKED) | Capacidades del hardware elegido | Hardware + seguridad | PENDIENTE |
| 14 | Historial de estado de dispositivos | Colección histórica · solo estado actual | Atribución en el tiempo | Atribución incorrecta | `DEVICE_STATUS_HISTORY_REQUIRED` | Frecuencia de cambios de estado | Líder técnico | PENDIENTE |
| 15 | Reintentos y backoff | `maxAttempts` y backoff concretos · sin reintentos automáticos | Recuperación ante fallas transitorias | Sobrecarga o pérdida | Retry policy y scheduler (BLOCKED) | Métricas de fallas transitorias en la topología objetivo | Líder técnico + operaciones | PENDIENTE |
| 16 | Backend de métricas | Opciones a evaluar por el equipo (sin proveedor preseleccionado) | Visibilidad operativa | Costo o datos sensibles fuera de control | Métricas (placeholder) | Presupuesto; requisitos de datos | Operaciones | PENDIENTE |
| 17 | Umbrales y enrutamiento de alertas | Umbrales por tipo · on-call · solo registro | Tiempo de respuesta | Fatiga de alertas o incidentes no vistos | Alertas (placeholder); QUARANTINE_BACKLOG_HIGH, AUTHORIZATION_DENIED_SPIKE | Volumen esperado; equipo de guardia | Operaciones | PENDIENTE |

## Dependencias entre decisiones

- 1 → 2 → 3: el mapeo depende de los atributos que entregue el IdP; la SoD depende de los roles.
- 4 depende de una autoridad temporal (relacionada con 8 y 11).
- 6 condiciona 5 (un legal hold necesita retención definida).
- 7 condiciona si `resolve` exigirá `VERIFIED`.
