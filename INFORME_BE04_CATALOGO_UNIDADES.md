# Informe BE-04 — Catálogo de variables, unidades y normalización

**Fecha:** 16/11/2026. **Estado BE-04: PARCIAL.** Etapa documental preparada; cierre físico/científico y aprobación FE/BE pendientes. No es implementación ni Done.

## 1. Alcance y Git

Se verificaron árbol limpio, nombre Camila Gonzalez y email camiiigonzalez1503@gmail.com; se ejecutó fetch origin y se creó `feature/be-04-catalogo-unidades` desde `origin/dev`, ambos en `1bb20f76b7a739f42c75b37b9a64315276560ec1`. La rama no existía antes. No incorpora los commits exclusivos `28556ff485f2a9f2f2239c0a612ac623dc33fdef` (BE-02) ni `c2a4b3175eef12b91e0d1e554082b4d281cdbe55` (BE-03).

Los PR #2 y #3 se consultaron en lectura; ambos siguen Draft abiertos y no fusionados al iniciar esta tarea. Sus propuestas son referencias, no contratos aprobados. No se modifican esas ramas, sus seis/tres documentos ni los acuerdos base. Esta entrega solo crea los seis archivos BE-04 y no hace commit/push/PR.

## 2. Fuentes y precedencia

Acuerdos confirmados del plan05/11 y ESPECIFICACION.md → código para comportamiento existente → especificaciones técnicas → propuestas históricas. Las fichas acreditan características documentadas del modelo, no identificación del equipo instalado ni mediciones reales. No se tomó ningún ejemplo documental o mock como captura de campo.

| ID | Fuente consultada | Evidencia utilizada / límite |
|---|---|---|
| S01 | IMPLEMENTATION_PLAN.md, ESPECIFICACION.md, SCHEMA_PROPUESTA.md, AGENTS.md, DEFINITION_OF_DONE.md de dev1bb20f7 | Alcance, arquitectura, nombres públicos, aislamiento, null, UTC, convenciones y DoD; estados históricos de esos archivos no se reescriben aquí |
| S02 | Plan_Trabajo_Backend_A26T02 (1).docx,05/11, §§3,7, etapa1,5 y pendientes | Backend normaliza unidades; distinguir fechas/ausencias; catálogo validado con Agronomía/ingesta antes de cerrar. Sin suscripción MQTT desde be-agro |
| S03 | Especificacion_Tecnica_UADE_A26T02_NUEVA_COPIA.docx,30/10, §§2,5,10–13,17 | Propuesta2.2 measurements, derived, referencias y auxiliares; no firmware productivo certificado. Sus propuestas de otras colecciones/consumo MQTT no sustituyen S01/S02 |
| S04 | Anexo_Formulas_S8_UADE.docx,30/10, §§1,3–8 | Procedencia, condiciones de fórmulas, soil_moisture_sensor_pct, calculated/laboratory, ensayos y calibración; ejemplos didácticos |
| S05 | SOIL-MB-THC-S-DS.pdf, Slicetex Rev.04,01/11/2024; tabla1 p.2, tabla4 pp.15–16 y notas p.17 | Cinco registros, escalado, resolución, rangos y exactitud publicada. Texto extraído y páginas2/15 revisadas visualmente; no se probó hardware |
| S06 | INFORME DE NECESIDADES AGRONOMICAS (1).docx, tablas variables pp.4–9 | Catorce requerimientos, unidades, profundidad y métodos a contextualizar; umbrales no adoptados como reglas productivas |
| S07 | Matriz_Comparativa_Sensores_UADE_A26T02.xlsx, Matriz de cobertura filas9–23, Catalogo sensores fila12 y Criterios y fuentes | S8 humedad sujeta a calibración; NPK comercial no es análisis específico; lectura directa OOXML sin editar ni recalcular workbook |
| S08 | [fe-agro f30c76d](https://github.com/Proyecto-Agro-Org/fe-agro/tree/f30c76dbd7f2f87aa5ef02e0be176f2e112fbb96), src/types/comun,sensor,historico,mapa; src/mocks/data/generadores.ts | Enum de seis variables, Medida valor/unidad, snapshot, histórico y unidades demo. HEAD remoto reconsultado e idéntico al SHA indicado |
| S09 | [iot-ingest e6ffda0](https://github.com/Proyecto-Agro-Org/iot-ingest/tree/e6ffda0f0a4b9a18298c239ac34cc61de6b1c3fa), README; measurements dto/service/repository/controller; devices dto/repository; body-parser y config/env | JSON libre, readings, payload string, metadatos y merge; código leído, no ejecutado. HEAD remoto reconsultado e idéntico |
| S10 | [PR #2](https://github.com/Proyecto-Agro-Org/be-agro/pull/2), informe en28556ff | Propuesta de IDs/BSON y bloqueo Atlas; relaciones/tipos físicos siguen sin confirmar |
| S11 | [PR #3](https://github.com/Proyecto-Agro-Org/be-agro/pull/3), DTOs en c2a4b31 y descripción de auditoría | Formas de respuesta, nulabilidad, unidad string, schemas cerrados propuestos y D03-14. No son contratos finales ni Zod ejecutable |
| S12 | Proyecto A26T02 – Red IoT de Sensores de Suelo con Inteligencia Artificial para Evaluación de NPK y Variables Ambientales-4 (1).docx, §5 | Ejemplo ilustrativo soil/nutrients/device/location, sin unidades inequívocas. Releído mediante extracto local; inventario histórico no es Atlas |

Los documentos locales se consultaron mediante extractos ya disponibles; se contrastaron además los originales DOCX S02–S04/S06, el XLSX S07 por XML y el PDF S05. No se modificaron los originales ni se incluye documentacion-referencia/. No se verificaron fuentes secundarias citadas dentro de esos documentos como si se hubieran leído; no se compararon productos para compra.

## 3. Hallazgos comprobados y límites

- S8 documenta humedad reportada, temperatura y CE como lecturas principales, salinidad/TDS como indicadores estimados; **no NPK ni pH**. Humedad del suelo rotulada %RH no prueba humedad ambiental ni VWC calibrada. S05 nota5.2 describe pérdida de masa sobre una muestra de1kg: no se identifica automáticamente con θg sobre masa seca del anexo; se registra la aclaración pendiente.
- Ficha: T−40..80°C, humedad0..100%RH, CE0..20000µS/cm; resolución0,1°C/0,1%/1µS/cm; salinidad/TDS1mg/L. Exactitud de temperatura publicada ±5°C a25°C, no ±0,5. No se inventó precisión instalada ni se confundió uint16 con rango físico.
- S03 propone soil_moisture_reported_pct; S04 usa soil_moisture_sensor_pct. derived/calculated también difieren, y air_content_pct no distingue denominadores. Necesitan interpretación versionada, no alias implícitos.
- Ingesta almacena objeto no vacío con _receivedAt servidor y _id generado; no exige magnitudes/unidades/tenant/adquisición. Un payload string puede quedar anidado. Estado de dispositivos es merge, no frame homogéneo.
- FE declara seis variables y Medida={valor:number|null,unidad:string}; mocks usan %,°C,dS/m,mg/kg. La existencia de una unidad demo o un campo con nombre sugerente no demuestra la unidad física persistida.
- Catálogo:21 magnitudes candidatas y nueve grupos auxiliares, con fuentes, tipos, unidades, resolución, rangos, null, conversiones, calibración y estado. Incluye los14 requerimientos agronómicos y distingue las dos definiciones de aire; V03 ambiental queda sin evidencia de adquisición.
- Sin acceso a Atlas, captura MQTT/hardware ni referencias analíticas reales. No se inspeccionó remoto Atlas ni se transformaron documentos existentes; faltan formatos, BSON, IDs, unidades y calibraciones reales para cierre.

## 4. Entregables

| Archivo | Contenido |
|---|---|
| [CATALOGO_VARIABLES_BE04.md](docs/CATALOGO_VARIABLES_BE04.md) |21 magnitudes y nueve grupos auxiliares; campos/precisión/unidades/procedencia y contraste FE/BE |
| [MATRIZ_NORMALIZACION_BE04.md](docs/MATRIZ_NORMALIZACION_BE04.md) | Formatos con evidencia, reglas condicionadas, preservación/rechazo y calidad de datos |
| [FECHAS_PRECISION_BE04.md](docs/FECHAS_PRECISION_BE04.md) | Adquisición/recepción, zonas, precisión, anomalías, orden e históricos |
| [EJEMPLOS_BE04.json](docs/EJEMPLOS_BE04.json) |21 escenarios exclusivamente sintéticos con premisas y resultados propuestos, sin conversor ejecutado |
| [DECISIONES_BE04.md](docs/DECISIONES_BE04.md) | D04-01…13 con clasificación, áreas de revisión y condiciones de cierre |
| INFORME_BE04_CATALOGO_UNIDADES.md | Alcance, fuentes, hallazgos, bloqueos, aceptación y validaciones |

## 5. Reglas propuestas y compatibilidad

Mantener bruto, unidad original, versión, procedencia y causa de invalidez. No coerción universal de strings; no ausentes→0; no clamp de rangos; no NPK inferido de CE; no VWC asumida. CE µS/cm/1000→dS/m solo con unidad confirmada; raw/10 solo al decodificar registros0/1, no sobre JSON ya escalado. El resto de fórmulas S04 necesita entradas válidas/método, sin constantes o calibraciones inventadas.

Separar validación sintáctica (JSON/tipos/gramática), técnica (unidad, rango instrumental, calibración, reloj, fuente) y agronómica (método, profundidad/cultivo, interpretación y alertas aprobadas). Estimación, derivación, laboratorio, declaración manual y lectura directa conservan identidad; data_status=simulated jamás pasa a medido por normalizar.

Propuesta: último frame parcial por adquisición, sin mezclar “últimas válidas” de otros instantes. Histórico solo con magnitud/unidad/método/profundidad compatibles, política de segmentación/exclusión a aprobar; no falsear truncado ni inventar puntos. UTC/zona/rango desde<hasta ya acordados; precisión submilisegundo, bordes y representación física siguen pendientes D03-14/D04-09.

El DTO Medida exige unidad:string aun con valor null. Unidad original y destino son distintas: si la unidad destino ya está acordada, puede acompañar valor:null sin afirmar unidad original ni convertir el número desconocido. Si magnitud/destino también están sin acuerdo, D04-06 debe resolver representación/diagnóstico; no inventarlos ni emitir unidad:null contra BE-03. Metadatos públicos y enum ampliado requieren coordinación; esta rama no agrega campos a DTOs ni modifica PR #3.

## 6. Dependencias, aceptación y continuación

**IoT/ingesta/datos:** aportar muestras sanitizadas por versión, reloj/zona/precisión, unidades/escalado y calibraciones, identidad confiable/aliases y configuración efectiva. **Agronomía:** validar VWC, especie/método N/P/K, densidades, profundidad/vigencia, condiciones de fórmulas, exactitud útil y alarmas. **FE/BE:** aprobar semántica de humedad/nutrientes, metadatos/null/unidades, snapshot y series, precisión y errores de compatibilidad. No solicitar secretos ni volcados masivos.

BE-04 puede cerrar solo con evidencia suficiente BE-02/Atlas, catálogo revisado por esas áreas, formatos y reglas de precisión/normalización aprobados y contrato FE/BE coherente. El plan no se marca completo sin revisión/integración y DoD.

Recomendaciones, sin ejecutar etapas siguientes:

- **BE-05:** preservar health/CORS/404 al migrar a TypeScript; preparar tipos de dominio/persistencia/DTO separados y futuros tests de mappers sin activar DB ni instalar en esta entrega. No convertir la propuesta en schema implementado por copiar Markdown.
- **BE-12:** primero resolver identidad/tenant y formato real; snapshot parcial, calidad/unidad y adquisición válidos; no usar documento de estado mergeado como medición ni completar NPK con mocks.
- **BE-13:** consulta autorizada, series comparables, orden/empates/precisión/duplicados y límites aprobados; preservar legacy y verificar políticas con fixtures controlados, sin modificar producción.

## 7. Validaciones de esta entrega

- **npm test: 5/5 aprobadas, 0 fallos**, suite existente health/CORS/404; sin cambios de código, tests o dependencias.
- **git diff --check: sin errores.** Como los seis archivos son nuevos sin seguimiento, se verificaron además explícitamente espacios finales, UTF-8, bloques Markdown y enlaces relativos de cada entregable.
- **EJEMPLOS_BE04.json: JSON válido**, sin claves duplicadas ni constantes NaN/Infinity.21 escenarios con IDs únicos, premisas/evidencia y resultados internos propuestos; comprobaciones seleccionadas de cero/null, parcial sin arrastre, conversión CE sintética1200→1,2, offset→UTC, calendario inválido, sobre JSON válido/malformado, unidad desconocida, preservación histórica y orden tardío. No se ejecutó un mapper para producir esos resultados.
- **Consistencia:**21 variables, nueve grupos auxiliares y13 decisiones presentes; cinco paths de measurements del ejemplo contrastados con S03 original y alias alternativo con S04; Medida requerida valor/unidad y enum de seis variables contrastados con OpenAPI del commit BE-03 mediante lectura Git, sin incorporarlo a la rama.
- **Fuentes reales disponibles:** nombres/unidades/resoluciones/rangos de S05 cotejados con texto y revisión visual de tablas; unidades demo %,°C,dS/m,mg/kg cotejadas con generadores FE del SHA fijado; ausencia de validación de magnitudes y generación de recepción cotejadas con DTO/service/repository y parser de ingesta. No se certifican unidades de documentos Atlas.
- **Git:** únicamente seis archivos nuevos BE-04, sin staged changes ni diff sobre archivos versionados. HEAD=origin/dev=1bb20f7; comprobado que no contiene los commits exclusivos de BE-02/03. main/dev conservan sus referencias; documentacion-referencia/ sigue excluida. Revisión acotada sin patrones de secretos, claves privadas o URI Mongo en los entregables.
- **Límites:** no se ejecutaron conversores, Zod, endpoints de negocio, consultas Atlas ni pruebas de calibración/precisión instalada. No se instaló nada ni se modificaron PR #2/#3, frontend o ingesta. No se hizo commit/push/PR ni se inició BE-05.

Resultado: etapa documental entregada para revisión; BE-04 permanece **parcial**, por evidencia física, aprobación científica y contrato FE/BE pendientes.

## 8. BE-04.1 — Auditoría final

### Evidencia y correcciones

Se releyeron los seis entregables, IMPLEMENTATION_PLAN.md y ESPECIFICACION.md; se contrastaron los originales S03/S04 y páginas2/15/17 de S05, y los tipos/generadores FE del SHA fijado. Se reconsultaron PR #2 y #3 y sus documentos en lectura: siguen abiertos Draft, sin fusionar, con heads28556ff y c2a4b31 respectivamente. No se obtuvo evidencia física adicional de Atlas ni de hardware.

Problemas documentales corregidos:

1. **Auxiliares:** el encabezado atribuía todas las filas a S03 salvo A09, aunque A01 usa ficha S05 y varios campos son legado S12. Se corrigieron atribuciones y se precisó que son grupos con tipos propios; no todos los campos son números ni todos requieren calibración física.
2. **Unidades y null:** se diferenció desconocer la unidad original de no tener unidad destino acordada. El primer caso no impide por sí solo un Medida con valor:null y destino canónico ya aprobado. Se precisaron catálogo, matriz y escenario E04-10 sin aprobar unidades productivas nuevas.
3. **Ejemplos internos frente a HTTP:** las proyecciones no son DTOResponse completos. Se agregó en E04-02 un candidato explícito de UltimaMedicion con seis Medida y timestamp, sujeto a premisas de semántica/unidades destino aún no aprobadas; se distinguió de los fragmentos internos. E04-04 explicita S8 como premisa, sin deducir modelo por ausencia de nutrients.
4. **Fronteras de fechas:** E04-08 es un caso de offset de entrada/legacy, no evidencia de que el dispositivo S03 emita offsets. Se separó esa frontera de la propuesta UTC del productor y de salida Z BE-03. La forma parseable tampoco demuestra reloj sincronizado.
5. **No finitos:** E04-14 contiene un string Infinity válido en JSON; se añadieron textos con literales NaN/Infinity/-Infinity para comprobar su rechazo sintáctico sin fingir muestras BSON.
6. **Dependencias:** se clasificaron las13 decisiones con las categorías Confirmada/Pendiente de IoT/Atlas/Agronomía/FE-BE, separando evidencia confirmada de pendiente. Se añadió el impacto por etapa y su justificación; enriquecimientos opcionales no son bloqueos individuales de compilar Express/health/CORS.
7. **Trazabilidad y cobertura:** los21 escenarios tienen sourceRefs/catalogRefs y comprobaciones específicas; se verificaron sus premisas/resultados documentales sin implementar un normalizador.

### Resultado de compatibilidad

Se mantienen las seis variables FE y la forma Medida valor:number|null/unidad:string. No se añaden ambiente, pH, salinidad/TDS o metadatos a sus DTOs cerrados propuestos. El candidato de snapshot respeta el componente UltimaMedicion de BE-03 en forma; esto no aprueba su semántica de humedad, unidades o política de frame. La unidad única y falta de método/procedencia por punto del histórico, la mezcla de fechas en snapshots y la precisión submilisegundo siguen abiertas, no ocultas como compatibilidad resuelta.

Confirmado documentalmente: cinco registros S8, unidades/escalas/resoluciones y rangos de ficha, CE µS/cm→dS/m con unidad conocida, y acuerdos null/UTC/procedencia. Confirmado por código: tipos/unidades demo FE y generación de recepción en ingesta. Ninguno demuestra unidad física del legado, calibración VWC, especie N/P/K o una medición ambiental instalada.

### Bloqueos y preparación de Draft

El plan mantiene **contrato mínimo BE-02/03/04** como condición de BE-05; su aceptación no se presume. No existe una dependencia técnica de la migración limitada del código actual con una curva VWC o resultado NPK particular. Los detalles de unidad/magnitud, snapshot y precisión sí deben resolverse antes de fijarlos en DTOs/mappers/fechas. Identidad, formatos y datos reales bloquean exponer mediciones en BE-12/13; calibraciones, métodos y segmentación bloquean las funciones que los utilicen. Ampliación del enum, derivados opcionales y umbrales de alertas se pueden postergar si quedan fuera de ese alcance. La tabla completa está en DECISIONES_BE04.md; no se inicia BE-05 por esta conclusión.

**Listo para revisión como PR Draft documental**, con BE-04 **parcial**, sin afirmar contrato definitivo, normalizador ejecutable ni cierre de las dependencias externas. No se creó PR.

### Validaciones BE-04.1 ejecutadas

- npm test: **5/5 aprobadas,0 fallos**. git diff --check sin errores y sin diff en archivos versionados/staged; revisión explícita de espacios en los seis archivos nuevos.
- JSON estricto sin claves duplicadas/NaN; IDs y referencias de21 escenarios válidos. **21/21 escenarios con comprobaciones explícitas** de expectativas sintéticas: cero/null/parcial, premisas de fuente, CE1200→1,2, laboratorio, offsets/calendario, desconocimiento de unidad, legacy, fracciones exactas, string/no finito, rango de modelo, payload, duplicado candidato, declaración manual, reloj no sincronizado, aliases y orden tardío. Son comprobaciones de instancias/expectativas, no resultados generados por código de normalización.
- Dos candidatos contrastados con el subconjunto JSON Schema que utilizan: UltimaMedicion de E04-02 y Medida de E04-10 condicionada a destino aprobado. No se ejecutaron Zod/TypeScript ni validador completo OpenAPI/JSON Schema.
- Cobertura documental de21 magnitudes, nueve grupos auxiliares, rangos/precisión/transformaciones y13 decisiones; enlaces relativos, referencias S01–S12/V01–V21/A01–A09/D04 y bloques Markdown revisados.
- Comprobación Node de pérdida de distinción entre .0001Z y .0002Z con Date.parse, sin instalar paquetes. No se implementó comparador exacto ni se validó precisión instalada.
- Rama feature/be-04-catalogo-unidades conservada; HEAD/origin/dev/main/dev siguen en1bb20f7. Solo los seis entregables BE-04 nuevos; documentacion-referencia/ excluida. Sin cambios a BE-02/03, frontend, ingesta, configuraciones, código ni datos. Sin Atlas, dependencias, commits, push, PR o inicio BE-05.
