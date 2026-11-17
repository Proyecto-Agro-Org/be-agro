# Matriz de normalización documental BE-04

**Estado:** propuesta parcial. Ninguna fila significa que se transformaron documentos. Fuentes S01–S12 en [informe](../INFORME_BE04_CATALOGO_UNIDADES.md). IDs de variables en [catálogo](CATALOGO_VARIABLES_BE04.md).

## 1. Fronteras y evidencia

La ingesta S09 acepta objeto JSON no vacío; su parser admite texto y, cuando no logra JSON, lo envuelve en `{payload:texto}`. El service elimina `_id` entrante y sustituye `_receivedAt` por `new Date()` del servidor; el repository hace insertOne. No valida magnitudes, timestamp de adquisición, calibración o tenant. Por ello “almacenado” no implica “medición utilizable”. No garantiza conservar los bytes originales del MQTT: hay parseo, trim y metadatos del servidor.

Para dispositivos hay merge de campos superiores por clientid; un subobjeto nuevo reemplaza al anterior, los campos omitidos pueden quedar antiguos. No usar ese documento mezclado como snapshot de adquisición. El resolvedor de ID puede inspeccionar payload JSON string para buscar aliases; eso no significa desanidar mediciones en /ingest. No se ejecutó ese código: contiene escrituras e índices.

S12 documenta soil/nutrients, S09 ejemplifica readings y sobre payload string, S03/S04 proponen measurements/derived/calculated/laboratory. Son evidencias distintas; no son cuatro formatos reales confirmados en Atlas. No se crea un parser universal ni un alias basado en palabras parecidas.

## 2. Original → normalizado → regla

Clasificación: **directo**, **conversión documentada**, **pendiente**, **rechazado para uso normalizado**, **preservado sin interpretar**. Rechazar aquí nunca significa borrar el bruto ni cambiar el endpoint de ingesta actual. Todas las salidas canónicas son propuestas internas.

| Formato/path de origen y evidencia | Campo normalizado candidato | Regla / clase | Unidad | Procedencia | Estado de aprobación |
|---|---|---|---|---|---|
| Registro1 int16 S05 | V01 soil_temperature_c | Conversión documentada raw/10 solo en frontera Modbus; si JSON ya escalado, no repetir | décimas °C → °C | Directa del sensor | Física documentada, habilitación de productor pendiente |
| Registro0 int16 S05 | V02 soil_moisture_reported_pct | Conversión documentada raw/10; sin identificarlo con VWC ni ambiente | décimas %RH reportado → % reportado | Directa reportada | VWC bloqueada |
| Registro2 uint16 S05 | V05 conductivity_ds_m | Conversión documentada /1000 desde µS/cm; conserva valor/unidad originales | µS/cm → dS/m | Directa con conversión de unidad | Condicionada a origen/unidad/versión |
| Registros3/4 uint16 S05 | V06 salinity_mg_l / V07 tds_mg_l | Directo en unidad confirmada; no recomputar factores no leídos | mg/L → mg/L | Estimada por dispositivo | Documentada, sin integración FE aprobada |
| measurements.soil_temperature_c S03/S04 | V01 | Directo si coincide contrato de versión y calidad; no raw/10 otra vez | °C → °C | Declarada como sensor; autenticidad por verificar | Propuesta de payload, no productor probado |
| measurements.soil_moisture_reported_pct S03 | V02 | Directo de lectura reportada; no V04 | % reportado → % reportado | Sensor declarado | Propuesta |
| measurements.soil_moisture_sensor_pct S04 | V02 | Pendiente alias versionado; si ambos paths discrepan, no elegir silenciosamente | % informado → % reportado | Sensor declarado | D04-01/02 |
| measurements.conductivity_us_cm S03/S04 | V05 | Conversión documentada /1000 solo si unidad confirmada; no confiar solo en nombre libre | µS/cm → dS/m | Medida con conversión | Propuesta condicionada |
| measurements.salinity_mg_l / tds_mg_l S03/S04 | V06/V07 | Directo; conservar estimación y configuración efectiva | mg/L | Estimada por dispositivo | Propuesta |
| derived.conductivity_ds_m S03 / calculated.conductivity_ds_m S04 | V05 | Preservado como derivado declarado; verificar entradas/versión antes de usar; no dividir por1000 nuevamente | dS/m | Conversión declarada | Pendiente precedencia ante conflicto con valor bruto |
| soil.temperature S12 | V01 | Pendiente de unidad, dispositivo, versión y rango; number solo no basta | Desconocida | Desconocida hasta verificar | Bloqueada BE-02/Atlas |
| soil.humidity S12 | V02/V03/V04 sin resolver | Preservado sin interpretar; no elegir magnitud por nombre | Desconocida | Desconocida | Bloqueada |
| soil.conductivity S12 | V05 sin resolver | Preservado sin interpretar; nunca decidir µS/cm/dS/m por valor como1,8 | Desconocida | Desconocida | Bloqueada |
| nutrients.nitrogen/phosphorus/potassium S12 | V08–V11 sin equivalencia fijada | Pendiente especie/fracción, unidad, método, profundidad, fuente y fecha | Desconocida; mg/kg demo no la prueba | Desconocida | Bloqueada; no atribuible al S8 |
| readings.soil_moisture / temp_c S09 README | V02/V01 candidatos | Preservados hasta contrato del productor; nombre temp_c sugiere, no garantiza, °C | No declarada formalmente | No demostrada | Propuesta, requiere muestras sanitizadas |
| readings.hum S09 ejemplo curl | Sin equivalencia | Preservado sin interpretar: no demuestra humedad ambiental ni VWC | Desconocida | Desconocida | Pendiente |
| payload string JSON, sobre EMQX S09 | Campos de versión encontrada | Deserialización futura explícita, acotada y validada como objeto; conservar sobre y campo original; no recursión ilimitada ni mezclar aliases en conflicto | Heredada de contrato interno confirmado | Depende de contenido, no del sobre | Propuesta; no parser implementado |
| payload texto no JSON S09 | Ningún valor de medición | Rechazado para normalización; preservar texto y diagnóstico, sin extraer números sueltos | No determinable | Ausente/inválida | Regla de diseño, no cambio de ingesta |
| laboratory.* y soil_reference.* S04/S03 | V04,V08–V21 según magnitud | Validar identidad de muestra, método, base seca, profundidad, vigencia, unidades y calibración; no unir al frame por cercanía sin política | Según catálogo | Laboratorio/campo; derivados identificados | Pendiente Agronomía/FE/BE |
| derived.air_content_pct S03 | V19 o V20 sin resolver | Preservado sin interpretar hasta definir denominador | % ambiguo | Derivada declarada | D04-10 |
| calculated.total_porosity_pct y air_filled_* S04 | V16,V19,V20 | Verificar referencias e inputs; si falta VWC validada, aire=null; no usar densidad por defecto | % con denominador explícito | Derivada | Propuesta científica condicionada |
| connectivity/device_status/geolocation S03 | A02–A06, no Variable FE | Directo solo con unidad/fuente confirmada; CSQ99 desconocido; GNSS no instalado→null; no confundir estado con medición | Ver catálogo | Sensor, estimada o manual, según campo | Propuesta; no nuevo endpoint |
| timestamp / _receivedAt S03/S09 | adquisición / recepción separadas | Validación/normalización temporal según documento de fechas; no fallback implícito | ISO con zona / BSON Date | Dispositivo / servidor de ingesta | UTC acordado; detalles pendientes |

No se asignan entityId, campo ni área desde telemetría no confiable. La correlación de dispositivo y el filtro por cliente preceden a exponer datos; tener un valor válido no demuestra permiso de lectura. Nunca consultar datos ajenos y filtrarlos después.

## 3. Procedencia y trazabilidad propuestas

| Clase | Prueba necesaria | Tratamiento |
|---|---|---|
| Medición directa | Fuente/dispositivo, registro, unidad, instante, calibración y estado de adquisición | Mantener lectura; conversión de unidades registra regla sin presentarla como otra medición |
| Derivada | Fórmula documentada/versionada, entradas referenciadas, unidades y condiciones compatibles | Registrar método, referencias, calculated_at y calidad; fecha de cálculo no reemplaza adquisición |
| Estimación | Método/modelo/configuración y responsable; incluye salinidad/TDS internos | Etiquetarla como estimación; no convertirla en ensayo independiente |
| Laboratorio | Informe/ensayo, muestra, especie/fracción, método, profundidad, fecha y vigencia | Preservar semántica analítica; no interpolar como si fuera lectura S8 continua |
| Declarada manualmente | Autoridad/registro de alta, instante y fuente declarada | No asumir que es sensor; distinguir mecanismo de carga de origen científico |
| Ausente/inválida | Valor y motivo originales conservados | Proyección null y diagnóstico interno seguro; no inventar causa que no se conoce |

Se propone conservar valor/unidad originales, formato/versión, source_refs, método/calibración, identidad de muestra o sensor, precisión y estado de calidad. **No es un schema BSON ni extensión HTTP aprobados**; BE-02 y BE-03 deben acordar sus formas. data_status=simulated también debe conservarse: dato sintético nunca migra a medido por cambiar un mapper.

## 4. Calidad: decisiones observables, sin conversiones reales

| Caso | Validación sintáctica | Técnica / normalización propuesta | Evaluación agronómica separada |
|---|---|---|---|
| null / campo ausente | Ambos JSON válidos, semántica distinta | null de salida si no utilizable, con causa distinta; conservar bruto | No inferir déficit por ausencia |
| Lectura parcial | Objeto válido no implica completo | Propuesta frame único: variables faltantes null, sin completar con frame anterior | No mezclar muestra de laboratorio con snapshot |
| Cero válido | number0 finito, no ausencia | Conservar cuando magnitud/rango/fuente lo permiten; no usar truthiness | Interpretar según método, no alarmar automáticamente |
| String numérico | String no es number | Sin coerción general. Parseo solo para formato/versionado aprobado, preservando texto/unidad y gramática; vacío/espacios no son cero | No inferir validez por parseabilidad |
| NaN/Infinity | No son números JSON válidos; strings homónimos sí son strings | Rechazar para valor normalizado; BSON double no finito, si existiera, no serializar como número válido | No evaluar |
| Unidad desconocida | Puede ser string válido | Preservar bruto; no convertir/publicar número sin unidad conocida. Con unidad destino previamente acordada puede emitirse valor:null con esa unidad canónica, sin afirmar unidad de origen. Si destino/magnitud tampoco están acordados, D04-06 debe resolver la representación; no unidad:null en Medida | No aplicar umbral |
| Timestamp inválido/faltante | Validar gramática y calendario, no solo regex | No sustituir por recepción. Sin adquisición válida, fuera de serie basada en adquisición; no descartar original | Diagnóstico de fecha, no agronómico |
| Duplicado candidato | JSON/shape válido | Sin borrado ni deduplicación por timestamp o valor. Clave confiable y política por acordar; conservar trazabilidad | No contar repetición como evento nuevo por defecto |
| Fuera de rango del equipo | JSON number válido | Marcar no utilizable si regla/modelo confirmados; no clamp, no convertir a cero | Rango instrumental no es umbral de cultivo |
| Fuera de rango agronómico orientativo | Puede ser técnicamente válido | Preservar valor validado | Solo alerta con cultivo, método, unidad, profundidad y regla aprobados |
| Payload malformado | Texto no JSON u objeto de forma no reconocida | Diagnóstico, preservar; ningún intento heurístico de recuperar mediciones | No evaluar |
| Formatos históricos mezclados | Cada documento puede ser válido individualmente | Mappers versionados, sin backfill ni cambio bruto; segmentos comparables de series | No mezclar métodos incompatibles por coincidir unidad |
| Dos aliases/unidades incompatibles | Sintaxis puede aprobar | Conflicto explícito; no “último gana” ni media de valores | Resolver origen antes de uso |

## 5. Conversiones condicionadas y política histórica

Solo CE µS/cm→dS/m es una conversión directa de unidad documentada para una medición S8. El /10 de registros0/1 es decodificación del registro, no una nueva calibración; no aplicarlo al JSON ya escalado. NO₃-N→NO₃⁻ es conversión de especie con datos analíticos, no prueba que la CE permita calcular nitrato. Las demás fórmulas S04 exigen ensayos/referencias; no se implementan.

Una serie solo es comparable con magnitud, especie, unidad normalizada, método, profundidad, calibración y procedencia compatibles. Proponer segmentación/rechazo controlado en lugar de mezclar todo en una respuesta con unidad única; el comportamiento HTTP y la información de exclusiones requieren acuerdo FE/BE. No devolver puntos inventados para simular huecos ni truncado=false que oculte otra política. Consulta histórica y última lectura requieren catálogo autorizado de BE-02.

La recomendación inicial es snapshot parcial del mismo frame de adquisición; “última válida por variable” se posterga hasta que exista representación explícita de fechas por variable y reglas de vigencia. No agregar una lectura de laboratorio antigua a un timestamp nuevo. Ver D04-05/07.

## 6. Alcance de los ejemplos auditados

Los 21 casos de [EJEMPLOS_BE04.json](EJEMPLOS_BE04.json) contienen fragmentos brutos y proyecciones internas propuestas. No son DTOResponse completos; nombres internos como soil_temperature_c no se envían automáticamente como campos FE. E04-02 incluye además un candidato explícito de UltimaMedicion, con timestamp y las seis Medida requeridas, sujeto a las premisas de unidad destino/semántica. Se comprueba su forma contra BE-03, sin aprobar esas premisas ni modificar su contrato.

E04-04 declara S8 sin fuente adicional como premisa: no se deduce esa identidad de la mera ausencia de nutrients. E04-10 distingue falta de unidad destino acordada de ignorancia de unidad original. E04-14 separa el string JSON válido "Infinity" de textos con NaN/Infinity numéricos inválidos; no se afirma probar doubles BSON reales. El ejemplo de adquisición con offset es un caso sintético de fecha de entrada/legacy: no se atribuye al payload UTC propuesto por S03 como si éste hubiese aprobado emitir offsets arbitrarios.
