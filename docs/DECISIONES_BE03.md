# Decisiones pendientes de los contratos BE-03

**Estado:** inventario para revisión. Ninguna fila constituye una nueva decisión aprobada. [Informe](../INFORME_BE03_CONTRATOS_API.md) · [OpenAPI](openapi.json).
La jerarquía, colecciones convencionales, aislamiento por cliente, Zod previsto, null sin cero y 404 de recursos ajenos ya están acordados; no se reabren como alternativas.

| ID | Decisión necesaria | Evidencia / situación | Impacto y condición de cierre |
|---|---|---|---|
| D03-01 | Google real y ciclo de sesión | FE usa email/password, Google demo y Bearer sessionStorage; backend no autentica | Login, recuperación, expiración/logout, transporte, CSRF/CORS y alta cliente. Equipo FE/BE aprueba flujo; no inventar rutas/body Google |
| D03-02 | Endpoint real de campos | Solo GET /auth/demo/campos en MSW; plan sugiere /campos | Aprobar ruta y fuente confiable; GetCamposResponse listo sin path productivo |
| D03-03 | ¿Última medición necesita ruta propia? | SensorDetalle ya incluye ultima_medicion | Reutilizar forma actual; no añadir /ultima-medicion sin necesidad/aprobación |
| D03-04 | Transición de errores | FE/MSW error string frente al objetivo code/message | Adaptar parser/tests FE conjuntamente y mantener health legado hasta cambio expresamente aprobado |
| D03-05 | Validación de fechas/rangos | UTC de salida, zona e histórico desde<hasta ya acordados; mock más permisivo | Aplicar lo aprobado; acordar perfil restringido adicional, bordes inclusivos y rango de alertas, con pruebas negativas |
| D03-06 | Límites y truncado definitivos | FE manda 1000; mock histórico default500/max1000; alertas default50/max200 | Revisar capacidad real, orden estable/truncado; no fijar rango de 30 días o frecuencia de muestras como requisito |
| D03-07 | Fuente/ciclo de alertas | Listas demo, ausencia visual a cargo de FE | Aprobar qué entrega API, filtros/orden, persistencia/cálculo; no exigir worker/historial desconexión |
| D03-08 | IDs y autorización física (BE-02) | Correlación clientid/device_id/_id y lotes no comprobadas; Atlas bloqueado | Catálogo confiable y relaciones demostradas para todos los endpoints privados; aprobar sin migraciones supuestas |
| D03-09 | Unidades/procedencia y fechas de datos (BE-04) | Ingesta JSON libre; S8 no NPK/pH ni VWC directa | Mantener Medida.unidad string y null; decidir lectura parcial/última válida, adquisición/recepción, unidades y mapper sin imponer conversiones |
| D03-10 | Query estricta y extensibilidad | Propuesta de rechazar desconocidos/duplicados y formatos numéricos no canónicos; respuestas cerradas | Acordar cambios respecto de MSW/TS estructural; jamás usar tenant público para autorizar |
| D03-11 | Completar identidad y campo_id de respuestas | Login permite solo token, UsuarioLogin IDs opcionales y AreaApi.campo_id opcional | Mantener compatibilidad inicial; endurecer solo con migración acordada; no usar ausencia como tenant default |
| D03-12 | Estado/conectividad y ubicación vigente | UI usa conectado/desconectado con umbral demo; estado técnico no es adquisición | Acordar fuente temporal, política/umbral y coordenadas; preservar sensores sin ubicación/lecturas |
| D03-13 | Validación especializada de OpenAPI y código de diseño | No hay validador OpenAPI/Zod/TypeScript instalado | Validar con herramientas aprobadas en etapa posterior; checks locales parciales no certifican conformidad completa |
| D03-14 | Precisión de la comparación de instantes | Patrones admiten fracciones arbitrarias; Date.parse pierde precisión inferior al milisegundo | Implementar/probar comparación que preserve precisión u obtener acuerdo FE para restringirla; no cambiar el formato por suposición |

## Clasificación y momento de resolución — auditoría BE-03.1

Las categorías describen la evidencia, no una aprobación nueva. Una misma decisión puede contener un acuerdo vigente y una ampliación pendiente; se separan aquí para no volver a someter a aprobación lo ya acordado.

| ID / alcance | Clasificación | Antes de implementar / posibilidad de postergar |
|---|---|---|
| D03-01 flujo real de autenticación | Propuesta pendiente de aprobación | Resolver antes de login real y protección de rutas. Bearer/sessionStorage está confirmado por código FE, pero no prueba un proveedor ni una sesión real |
| D03-02 ruta productiva de campos | Propuesta pendiente de aprobación | Resolver antes del endpoint de campos; su catálogo confiable depende también de D03-08. El mock está confirmado por código, sin aprobar una ruta real |
| D03-03 última medición en SensorDetalle | Confirmada por código | Mantenerla en la respuesta actual. La propuesta de una ruta adicional puede postergarse sin cambiar el contrato existente |
| D03-04 envoltorio de error uniforme | Confirmada por documentación aprobada | ESPECIFICACION.md exige code/message; el parser legado está confirmado por código. Coordinar su adaptación antes de integrar errores de negocio; no reabrir el formato acordado |
| D03-05 UTC de salida, zona y desde<hasta del histórico | Confirmada por documentación aprobada | Aplicar al implementar histórico. El mock permisivo no sustituye el acuerdo de ESPECIFICACION.md |
| D03-05 perfil restringido de fecha, bordes y rango de alertas | Propuesta pendiente de aprobación | Resolver antes de sus validadores: mayúsculas, segundos obligatorios y exclusión de segundos intercalares restringen RFC3339; no son requisitos deducibles solo del tipo string |
| D03-06 límites/defaults productivos y truncado | Propuesta pendiente de aprobación | Resolver antes de consultas históricas/alertas. Los valores demo están confirmados por código; no se ha demostrado capacidad productiva |
| D03-07 fuente y ciclo de alertas | Propuesta pendiente de aprobación | Resolver antes de alertas y agregados que dependen de ellas. Worker e historial de desconexión pueden postergarse: no son necesarios por el contrato observado |
| D03-08 IDs, catálogo y relaciones persistidas | Bloqueada por BE-02 o Atlas | Resolver antes de repositories privados y aislamiento real. No equivaler lotes/áreas ni clientid/cliente_id por sus nombres |
| D03-09 BSON, fechas y campos realmente disponibles | Bloqueada por BE-02 o Atlas | Evidencia física necesaria antes del mapper de telemetría. Las reglas adicionales de normalización son propuestas para una etapa autorizada; no se inicia BE-04 |
| D03-10 query estricta y respuestas cerradas | Propuesta pendiente de aprobación | Resolver antes de validadores y política de compatibilidad. Rechazo de duplicados/desconocidos y extras no se deriva de interfaces TypeScript |
| D03-11 IDs opcionales de login y campo_id opcional de AreaApi | Confirmada por código | Conservar compatibilidad. Hacerlos obligatorios es una propuesta postergable con migración FE/BE; el contexto interno de cliente confiable sigue siendo obligatorio |
| D03-12 estado, umbral y ubicación vigente | Propuesta pendiente de aprobación | Resolver antes de derivar estados/mapear coordenadas; timestamps físicos también dependen de BE-02. El umbral demo no es una regla productiva |
| D03-13 validación especializada y ejecución Zod/TS | Propuesta pendiente de aprobación | Puede postergarse para publicar documentación como Draft. Debe resolverse antes de declarar conformidad completa y aprobar el contrato/implementación; la ausencia local de herramientas fue comprobada |
| D03-14 precisión temporal | Propuesta pendiente de aprobación | Resolver antes del validador de rangos; el defecto de Date.parse está confirmado por ejecución local, no se resolvió instalando una librería ni reduciendo el contrato |

Además están **confirmados por código** los nueve métodos/rutas de negocio, nombres y opcionalidad de campos observados, enums y transporte descritos en la matriz; esto no confirma endpoints desplegados en be-agro. Están **confirmados por documentación aprobada** el aislamiento desde identidad confiable, jerarquía, recurso ajeno 404, null sin cero y DTOs separados de persistencia. No dependen de una nueva elección de diseño.

## Criterios para pasar el contrato de borrador a aprobado

1. Revisión conjunta FE/BE de paths, envoltorios, null/opcionales, headers, fecha, límites y error estándar.
2. Resolución de auth/campos/sesión sin copiar endpoints demo; pruebas con cliente real cuando exista implementación autorizada.
3. Evidencia suficiente de BE-02 para catalogar y aislar consultas, sin afirmar Atlas ni lotes verificados por este documento.
4. Definición de unidades/origen/fechas por BE-04 cuando se autorice; no desarrollarlo automáticamente aquí.
5. Validación especializada de OpenAPI y ejemplos; schemas Zod compilados/probados tras instalación/migración autorizadas.
6. PR y revisión del equipo en el flujo acordado. Esta entrega no crea PR ni marca BE-02/03 Done.

Cambios de aprobación se registrarán con responsable/evidencia/fecha. No se inventan responsables individuales ni acuerdos de reunión que no hayan ocurrido.
