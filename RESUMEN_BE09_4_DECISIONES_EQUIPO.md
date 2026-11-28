# BE-09.4 - Resumen ejecutivo para decisiones del equipo

**Propuestas pendientes de aprobación.** Integrar esta documentación en dev no aprueba
arquitectura, configura proveedores ni habilita autenticación. No se asignan personas ni fechas.
Cada responsable indicado es un rol sugerido, todavía por designar.

## Página 1 de 2 - Catálogo, backend y política de sesión

### D01 - Cardinalidad | Pendiente de aprobación

**Propuesta:** un cliente vigente por usuario, acorde al alcance actual; sesiones ligadas a ese cliente.
**Alternativa:** varios clientes con membresías y selección autorizada; cambia esquema, API y UX.
**Sin resolver:** no se puede cerrar catálogo ni contrato de identidad.
**Responsables sugeridos:** Producto, backend y frontend.
**Tras aprobar:** fijar invariantes y fixtures; implementar el catálogo cuando también se cumplan D02/D03/D06.

### D02 - Catálogo físico y unicidad | Pendiente de aprobación

**Propuesta:** principal único por realm/issuer/sub; IDs estables, BSON e índices aprobados,
pertenencia confiable y writer de bajas/cambios; nunca asignar cliente por email ni por petición pública.
**Alternativa:** adaptar catálogo existente con inventario y mapper explícito, sin migración inferida.
**Sin resolver:** duplicados o relaciones ambiguas impiden autorización fiable.
**Responsables sugeridos:** Datos/BE-02 y backend.
**Tras aprobar:** modelos/store/writer físicos, después de D01/D03 y prueba MongoDB básica autorizada.

### D03 - Baja, versión y concurrencia | Pendiente de aprobación

**Propuesta:** versión monótona mediante CAS, revalidación y revocación; aceptar touch contable
ya iniciado y trabajo ya admitido dentro de su lease. Acordar SLA de propagación.
**Alternativa:** impedir toda actividad tras el ACK de baja mediante coordinación/fence y conflictos probados.
**Sin resolver:** no puede prometerse revocación instantánea ni aprobarse el writer.
**Responsables sugeridos:** backend, Seguridad y Datos.
**Tras aprobar:** protocolo de cambios y pruebas deterministas de baja/reactivación; sin atomicidad entre stores supuesta.

### D04 - Transporte y política de sesión | Pendiente de aprobación

**Propuesta:** callback GIS y Bearer Agro; memoria como fuente única, storage opcional;
ratificar challenge 5 min, sesión absoluta 8 h, idle 30 min, múltiples sesiones y logout no confirmado.
**Alternativa:** cookie HttpOnly con otro contrato CSRF/CORS; límites de sesiones por definir.
**Sin resolver:** integración FE insegura/incoherente y riesgo XSS sin aceptación explícita.
**Responsables sugeridos:** frontend, backend, Seguridad y Producto.
**Tras aprobar:** adaptar transporte/restore/logout con D05, sin activar login productivo.

## Página 2 de 2 - Frontend, proveedores y habilitación controlada

### D05 - HTTP y correcciones frontend | Pendiente de aprobación

**Propuesta:** aprobar challenge, login Google, GET sesión y logout 204; identidad completa y
transición al error anidado ya acordado. Corregir 401 tardío, storage fallido, parser de errores y JSON ante 204.
**Alternativa:** renegociar rutas/DTO; password y Google-demo actuales son mocks, no contrato real aprobado.
**Sin resolver:** FE no puede recuperar/revocar sesión de manera compatible.
**Responsables sugeridos:** frontend/backend, con QA y Seguridad.
**Tras aprobar:** cambios FE y OpenAPI con fixtures; no requiere Atlas/GIS real para esas regresiones.

### D06 - MongoDB y pruebas distribuidas | Pendiente de aprobación

**Propuesta:** instancia local exclusiva autorizada, namespace aislado y replica set para
durabilidad/failover; permiso expreso para fixtures, índices y limpieza.
**Alternativa:** standalone solo para evidencia parcial; no sustituye distribución/durabilidad.
**Sin resolver:** no ejecutar la sonda ni certificar persistencia real.
**Responsables sugeridos:** Operación/Datos y QA, con Seguridad/backend.
**Tras aprobar:** sonda acotada y campaña M01-M12; catálogo/writer esperan D01-D03. Sin acceso a Atlas.

### D07 - Google Identity por entorno | Pendiente de aprobación

**Propuesta:** client ID web/audience, orígenes exactos y namespace separados; Preview estable;
nonce por intento y rotación coordinada. ID token Google y sesión Agro son distintos.
**Alternativa:** otros orígenes/flujo OAuth requieren revisión; no wildcard ni audiencia compartida sin acuerdo.
**Sin resolver:** un deployment Success no demuestra login válido.
**Responsables sugeridos:** administrador Google, frontend/backend y Operación/Seguridad.
**Tras aprobar:** configuración y pruebas GIS autorizadas por entorno; ninguna habilitación Production implícita.

### D08 - Operación, QA y Preview | Pendiente de aprobación

**Propuesta:** limiter compartido, deadlines, logging seguro, alertas y rollback; permiso específico de Preview.
**Alternativa:** mantener auth deshabilitada hasta cerrar controles; limiter local no demuestra cobertura distribuida.
**Sin resolver:** no habilitar Preview ni afirmar protección operativa.
**Responsables sugeridos:** Operación, Seguridad, backend, frontend y QA.
**Tras aprobar:** con catálogo/MongoDB/GIS/FE validados, habilitación Preview y auditoría; Production exige otra aprobación.

**Pruebas y riesgos:** ejecutar M01-M12 y 22 escenarios E2E, incluidos replay, expiración,
revocación, cruces de cliente, token robado simulado y carreras con baja. Pendientes XSS,
consistencia, ACK perdido y aislamiento de entornos. 266/266 y 13/13 son evidencia local histórica,
no MongoDB/GIS/Preview reales ni una suite reejecutada en esta publicación documental.

**Orden:** acuerdos A/B en paralelo; C y preparación E/F; luego D/E/F, Preview G y auditoría H;
Production I separada. Ninguna implementación queda autorizada solo por este merge.
Registrar acuerdos y evidencias en el [plan A-I](PLAN_BE09_4_IMPLEMENTACION_Y_APROBACIONES.md).
