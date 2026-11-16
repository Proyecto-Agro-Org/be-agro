# Decisiones y dependencias BE-04

**Estado:** propuestas abiertas, sin aprobación inventada ni responsables individuales asignados. Las áreas indicadas deben revisar. [Informe](../INFORME_BE04_CATALOGO_UNIDADES.md).

Ya confirmado por documentación aprobada: normalizar en backend, conservar brutos/históricos, ausencia→null sin cero, separar adquisición/recepción y procedencias, no atribuir NPK/pH al S8, no equiparar humedad reportada con VWC, aislamiento desde identidad confiable y colecciones convencionales. No se reabren como opciones.

| ID | Decisión y evidencia faltante | Clasificación / revisión necesaria | Cuándo resolver / cierre verificable |
|---|---|---|---|
| D04-01 | Formatos/paths reales, versiones, unidades, escalado y aliases contradictorios | Bloqueada BE-02/Atlas; IoT/ingesta/datos | Antes del mapper: muestras sanitizadas con tipos, productor/versionado y correlación confiable. soil/readings/measurements no son hechos físicos solo por figurar en ejemplos |
| D04-02 | Significado de humedad FE y alias reported/sensor; separar ambiente, lectura suelo y VWC | Propuesta pendiente + calibración bloqueada; IoT/Agronomía/FE-BE | Antes de publicar humedad real: confirmar magnitud, etiqueta, profundidad y curva/error si se exige VWC. Aclarar nota5.2 S05 (pérdida de masa) frente a %RH y denominador θg del anexo; no inventar sensor ambiental |
| D04-03 | CE, unidad original, correcciones/compensación ya aplicadas y método | Propuesta condicionada a evidencia; IoT/Agronomía/BE | Antes de conversión: documentar origen µS/cm; /1000 respaldado. No decidir por tamaño del número ni comparar umbral de extracto con sonda sin equivalencia |
| D04-04 | Especie/fracción N/P/K, método, laboratorio, ppm y base seca | Propuesta pendiente; Agronomía/FE-BE | Antes de exponer no-null: significado público y fuente/método compatibles. No derivar NPK/pH desde S8. pH/auxiliares pueden postergarse sin agregar enum |
| D04-05 | Último frame parcial versus última válida por variable | Propuesta pendiente; FE/BE/IoT | Antes de BE-12: propuesta frame único, sin completar con frames/ensayos anteriores. Otra opción requiere fechas por variable y política de vigencia |
| D04-06 | Metadatos de fuente/calidad/causa y unidad desconocida en DTO | Propuesta pendiente; FE/BE/datos | Antes de mappers públicos: Medida exige unidad:string incluso con valor null; no inventarla ni agregar extras a BE-03 cerrado. Aprobar forma interna/pública y UX de dato no representable |
| D04-07 | Series históricas comparables, cambios de unidad/método/profundidad, exclusiones y truncado | Propuesta pendiente; Agronomía/FE-BE | Antes de BE-13: segmentación y política HTTP aprobadas; unidad única por respuesta no puede ocultar mezcla incompatible |
| D04-08 | Salinidad/TDS, ambiente, pH y variables auxiliares en API | Propuesta pendiente; FE/BE | Puede postergarse: conservar brutos, no rutas ni enums nuevos. Requiere revisión coordinada DTO/OpenAPI/UI si se incluye |
| D04-09 | Zona, precisión fraccionaria, reloj, BSON Date, comparación y orden | Parte UTC/zona ya confirmada por docs; detalles propuestos, tipos físicos bloqueados; IoT/datos/FE-BE | Antes del parser/consultas de fechas: política aprobada sin pérdida submilisegundo. Vinculado D03-05/14; no sustituir adquisición por recepción |
| D04-10 | Fórmulas/insumos/versionado: aire con dos denominadores, MO1,72/1,724, densidades, ensayos y vigencia | Propuesta pendiente; Agronomía | Antes de derivados; se puede postergar enriquecimiento. Aceptación de método, inputs, calibración, profundidad y error; ninguna constante universal por ejemplo |
| D04-11 | Duplicados, seq/reinicios, identidad y namespace de mensajes | Propuesta pendiente + BE-02; IoT/ingesta/datos | Antes de deduplicar o afirmar idempotencia; brutos preservados. No crear índices/TTL ni eliminar lecturas |
| D04-12 | Redondeo y precisión numérica de salida por variable/método | Propuesta pendiente; IoT/Agronomía/FE-BE | Antes del mapper definitivo; resolución de ficha no es exactitud. Conservar precisión original y evitar redondeos intermedios |
| D04-13 | Rangos instrumentales, calibración efectiva, control técnico y umbrales agronómicos | Rangos de S05 documentados; política instalada pendiente; IoT/Agronomía | Antes de rechazar por modelo o emitir alarmas. Validar etiqueta, ficha y estado. ±5 °C es exactitud publicada; no “corregirla” a ±0,5 por suposición |

## Clasificación auditada y dependencia técnica por etapa — BE-04.1

**Confirmada** aplica a los acuerdos del párrafo inicial y a evidencia acotada: cinco registros/escalas/unidades/rangos de ficha S05, conversión CE con unidad conocida, formas del código FE y metadatos generados por ingesta. No confirma valores instalados, muestras Atlas ni aprobaciones nuevas. En una decisión mixta se separa esa evidencia de lo que falta resolver.

El plan exige para BE-05 un **contrato mínimo BE-02/03/04**. Sigue pendiente la aceptación conjunta de ese mínimo; esta auditoría no elimina esa condición ni autoriza comenzar BE-05. Técnicamente, migrar solo Express/health/CORS a TypeScript sin incorporar telemetría no necesita una curva VWC, análisis NPK o muestras Atlas. No se atribuye a cada decisión de dominio un bloqueo individual de esa migración. Si se amplía BE-05 para incluir DTOs/mappers o representación persistida de fechas, deben resolverse antes las decisiones que ese código vaya a fijar; no copiar el borrador como contrato aprobado.

| ID | Clasificación de lo pendiente | Impacto directo en BE-05 limitado a migración del código existente | Cierre requerido antes de BE-12 / BE-13 |
|---|---|---|---|
| D04-01 | Pendiente de Atlas; pendiente de IoT | Sin dependencia directa: no se leen ni transforman mediciones en esa migración | BE-12: formato/unidad/identidad reales y aislamiento; BE-13: coexistencia de formatos e interpretación histórica |
| D04-02 | Pendiente de IoT, Agronomía y FE/BE | Sin dependencia directa; no fijar semántica de humedad en tipos públicos nuevos | BE-12: qué significa humedad y unidad destino; VWC solo si calibrada. BE-13: separar series por magnitud/calibración |
| D04-03 | Pendiente de IoT y Atlas para origen; Agronomía para comparabilidad | /1000 con µS/cm conocido está confirmado documentalmente; no requiere implementar conversión en BE-05 | BE-12/13: unidad y correcciones confirmadas. Evaluación agronómica solo antes de comparar métodos/emitir alarmas |
| D04-04 | Pendiente de Agronomía y FE/BE; Atlas para datos heredados | Sin dependencia directa; migración no requiere inventar NPK | Antes de entregar valores NPK no-null: especie/fracción/método y mapeo. Si no hay fuente adicional, conservar null con unidad destino acordada; pH puede postergarse |
| D04-05 | Pendiente de FE/BE e IoT | Sin dependencia directa; no se implementa selección de última lectura en BE-05 | Bloquea selección de snapshot BE-12. BE-13 no debe heredar una mezcla de fechas por variable sin contrato |
| D04-06 | Pendiente de FE/BE | No bloquea compilar lo existente. Sí debe acordarse antes de materializar DTOs/mappers de telemetría si entraran en alcance de una migración posterior | BE-12/13: unidad destino, null, datos no representables y metadatos públicos; sin agregar extras contra BE-03 |
| D04-07 | Pendiente de FE/BE y Agronomía; Atlas para variedad real | Sin dependencia directa | BE-13: series compatibles, exclusiones, bordes y truncado; BE-12: no unir referencias incompatibles en snapshot |
| D04-08 | Pendiente de FE/BE | No bloquea migración ni obliga a ampliar API | Postergable en BE-12/13 si se conserva enum de seis variables. Guardar bruto no exige endpoint nuevo |
| D04-09 | Pendiente de IoT, Atlas y FE/BE; UTC/zona ya confirmadas | No bloquea health/CORS; sí debe resolverse antes de elegir una representación/comparador que reduzca la precisión de telemetría | BE-12/13: adquisición fiable, unidad temporal, offsets, precisión y orden; requiere concordancia con D03-14 |
| D04-10 | Pendiente de Agronomía | Sin dependencia directa | Postergable si se excluyen derivados/enriquecimiento. Antes de calcularlos: entradas, denominador, profundidad, vigencia y versión aprobadas |
| D04-11 | Pendiente de IoT y Atlas; FE/BE para semántica de resultados | Sin dependencia directa; no se cambia ingesta | Antes de deduplicar/agregar o afirmar idempotencia en BE-12/13. Puede acordarse preservar todos los registros sin deduplicación; timestamp solo no prueba duplicado |
| D04-12 | Pendiente de IoT, Agronomía y FE/BE | Sin dependencia directa; tipar como number no aprueba un redondeo | Antes del mapper numérico definitivo BE-12/13; no introducir redondeo silencioso como parte de migración |
| D04-13 | Pendiente de IoT y Agronomía; ficha documental confirmada | Sin dependencia directa | Antes de filtrar por rango instrumental/calibración en BE-12/13. Alarmas agronómicas son dependencia de la función de alertas, no requisito para devolver una lectura técnica válida |

En síntesis de dependencia, el **bloqueo formal de BE-05** es la aceptación del mínimo exigido por el plan, no cada enriquecimiento pendiente. Para BE-12/13 son bloqueantes las reglas que el mapper/consulta realmente necesita; sensores adicionales, derivados opcionales y umbrales de alertas pueden postergarse si se mantienen fuera de alcance. Estos plazos son análisis técnico, no aprobación de las propuestas.

## Condiciones para cerrar BE-04

1. BE-02 aporta inventario/muestras sanitizadas y relación confiable dispositivo/cliente, formatos y timestamps; sin ello el catálogo no es físico aprobado.
2. IoT confirma modelo/versión, cinco registros, escalado, unidades, factores reales, reloj/calidad y contenido capturado. No pedir secretos ni activar ingesta de prueba.
3. Agronomía confirma significado de humedad, calibración, especie/método de ensayos, profundidad/vigencia y condiciones de derivación/alertas. No convertir umbrales de informe en validadores universales.
4. FE/BE revisa nombres públicos, null/unidad desconocida, metadatos, snapshot, histórico, precisión y alcance del enum sin modificar PR #3 desde aquí.
5. Documentos aprobados y pruebas futuras de mappers/fechas/aislamiento en etapa autorizada; PR integrado y DoD satisfecho para Done. No marcar el plan completo por redactar esta entrega.

La ausencia de Atlas bloquea la confirmación física, no la preparación documental realizada. Estado BE-04: **parcial**, con entregables de propuesta preparados y cierre pendiente. No se inicia BE-05, no se modifican PR #2/#3 y no se instala ninguna herramienta.
