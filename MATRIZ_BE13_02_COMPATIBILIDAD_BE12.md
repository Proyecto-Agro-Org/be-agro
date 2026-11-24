# BE13-02 — Compatibilidad del candidato con BE-12

| Campo BE-12 | Documento protegido | Candidate BE13-02 | Estado | Autoridad o cambio pendiente |
|---|---|---|---|---|
| `eventId` | disponible | preservado | DISPONIBLE | confirmar estabilidad real EMQX |
| `sourceId` | disponible | preservado y atestado | DISPONIBLE | configuración productiva aprobada |
| `device` | `clientid` técnico | `{kind:'mqtt-clientid',value}` atestado | DISPONIBLE | autenticidad física todavía no demostrada |
| `receivedAt` | `_receivedAt` | preservado, no atribuible | DECLARADO NO CONFIABLE | política temporal aprobada |
| `declaredAt` | `sentAt`/`deviceTimestamp` | ambos preservados por separado | PENDIENTE DE AUTORIDAD | decidir reloj y conversión |
| `persistedAt` | opcional | preservado o `null` | PENDIENTE DE AUTORIDAD | definir instante de persistencia canónico |
| `magnitude` | payload libre | no promovida | BLOQUEADO | catálogo/extractor aprobado |
| `unit` | payload libre | no promovida | BLOQUEADO | catálogo/extractor aprobado |
| `value` | payload libre | no promovido | BLOQUEADO | semántica por magnitud |
| `missingReason` | no canónico | ausente | BLOQUEADO | reglas null/ausencia aprobadas |
| `provenance` | origen declarado | identidad técnica atestada; payload no atestado | PENDIENTE DE AUTORIDAD | mapper de procedencia e integridad BE-12 |
| `simulated` | `dataOriginDeclared` | no promovido automáticamente | PENDIENTE DE AUTORIDAD | evidencia y regla aprobadas |
| `metadata` | payload/contexto amplio | no convertido a metadata BE-12 | BLOQUEADO | allowlist explícita y límites |
| `clientId` | prohibido como autoridad | ausente | COMPATIBLE | lo resuelve la ventana BE-11/12 |
| `sensorId` | ausente | ausente | COMPATIBLE | lo resuelve la ventana BE-11/12 |
| `physicalDeviceId` | ausente | ausente | COMPATIBLE | resolución exacta posterior |
| `attributedAt` | ausente | ausente | COMPATIBLE | política temporal BE-12 bloqueada |

El flujo permitido termina en `Candidate`. Construir `TrustedMeasurementEvent` requiere otro componente y las autoridades pendientes; BE13-02 no lo crea ni llama al servicio de atribución.
