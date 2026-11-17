# Catálogo de variables y unidades BE-04

**Estado:** propuesta documental parcial, 16/11/2026. No prueba variables presentes en Atlas ni despliegue de firmware. Fuentes S01–S12 y precedencia en [informe](../INFORME_BE04_CATALOGO_UNIDADES.md). Decisiones en [DECISIONES_BE04.md](DECISIONES_BE04.md).

## 1. Evidencia y nombres

Los nombres canónicos siguientes son candidatos internos de normalización, no campos nuevos aprobados para HTTP o Mongo. FE mantiene `humedad`, `temperatura`, `conductividad`, `nitrogeno`, `fosforo`, `potasio`; no se renombra ese contrato desde esta rama. Un nombre que incluye una unidad expresa el significado propuesto, no demuestra la unidad de un documento antiguo.

Estados: **documentado** = respaldado por fuente técnica, no medición capturada; **código/demo** = observable en software, sin garantía física; **propuesta** = requiere acuerdo; **bloqueado** = falta evidencia física/calibración. En todos los casos el cierre del mapeo productivo sigue pendiente. Resolución, exactitud, cantidad de decimales en un ejemplo y precisión de almacenamiento son conceptos diferentes.

## 2. Magnitudes, paths y unidades

`M` significa `measurements` de la propuesta S03; `L` significa `laboratory` del ejemplo S04. Números de salida: finitos o null. `—` indica que no se encontró un path de payload, sin inventarlo.

| ID | Variable / nombre canónico propuesto | Original documentado | Fuente y procedencia | Unidad original → salida candidata | Tipo bruto → proyección | Estado |
|---|---|---|---|---|---|---|
| V01 | Temperatura suelo / soil_temperature_c | Modbus 1; M.soil_temperature_c; soil.temperature; readings.temp_c | S05 directa; S03 propuesta; S12 legado; S09 ejemplo | °C confirmado para Modbus/S03 → °C; unidad legado/readings por confirmar | int16 escalado / JSON libre → number o null | Documentado; mapeo legado bloqueado |
| V02 | Humedad reportada de suelo / soil_moisture_reported_pct | Modbus 0; M.soil_moisture_reported_pct; M.soil_moisture_sensor_pct en S04; soil.humidity | S05 directa como lectura reportada, no VWC; S03/S04 difieren en nombre | % RH rotulado por S05 → % reportado con semántica identificada; legado desconocido | int16 escalado / JSON libre → number o null | Documentado; alias/versionado propuesto |
| V03 | Humedad relativa ambiental / ambient_relative_humidity_pct | —; readings.hum/soil_moisture no la demuestran | Sin sensor/payload ambiental identificado | %RH solo como unidad candidata de esta magnitud → por aprobar | Sin tipo observado → number o null candidato | Propuesta, sin evidencia de adquisición; no S8 |
| V04 | Humedad volumétrica / soil_moisture_volumetric_pct | soil_reference.moisture_volumetric_pct en S03; θ_v_calibrada en S04 | Calibración/ensayo externo y derivación, no lectura directa S8 demostrada | % de volumen → % vol. candidato | Referencia/derivación → number o null | Bloqueado por calibración y Agronomía |
| V05 | Conductividad / conductivity_ds_m | Modbus 2; M.conductivity_us_cm; derived.conductivity_ds_m; calculated.conductivity_ds_m en S04; soil.conductivity | Medición directa y su conversión de unidad; S03/S04/S05 | µS/cm → dS/m; legado sin unidad comprobada | uint16 / number → number o null | Conversión documentada; habilitación productiva condicionada |
| V06 | Salinidad / salinity_mg_l | Modbus 3; M.salinity_mg_l | S05 y S03/S04; estimación interna de la sonda | mg/L → mg/L | uint16 / number → number o null | Documentado; no medición química independiente |
| V07 | Sólidos disueltos totales / tds_mg_l | Modbus 4; M.tds_mg_l | S05 y S03/S04; estimación interna de la sonda | mg/L → mg/L | uint16 / number → number o null | Documentado; no NPK |
| V08 | Nitrógeno de nitrato / nitrate_n_mg_kg | NO₃-N en entradas de S04; sin path fijado | Laboratorio, eventualmente derivado de extracto | mg N/L del extracto o mg N/kg seco → mg N/kg seco según método | Resultado analítico → number o null | Propuesta; no es nitrogeno genérico ni S8 |
| V09 | Nitrato / nitrate_no3_mg_kg | L.nitrate_no3_mg_kg; nutrients.nitrogen solo genérico | S04 laboratorio/derivado; S12 no demuestra especie | mg/kg como NO₃⁻; ppm solo con base de masa compatible → mg/kg como NO₃⁻ | number analítico → number o null | Propuesta, especie/método bloquean mapeo legado |
| V10 | Fósforo disponible / phosphorus_available_mg_kg | L.phosphorus_available_mg_kg; nutrients.phosphorus genérico | S04 laboratorio; no S8 | mg/L extracto o ppm de base explícita → mg/kg suelo seco | number analítico → number o null | Propuesta; Olsen/Bray no intercambiables |
| V11 | Potasio intercambiable / potassium_exchangeable_mg_kg | L.potassium_exchangeable_mg_kg; nutrients.potassium genérico | S04 laboratorio; no S8 | mg/L extracto o ppm de base explícita → mg/kg suelo seco | number analítico → number o null | Propuesta; fracción/especie por aprobar |
| V12 | pH / soil_ph | L.soil_ph | S04 laboratorio/electrodo independiente; no S8 | Escala pH adimensional → escala pH | number → number o null | Documentado como requerimiento; sin adquisición comprobada |
| V13 | Materia orgánica / organic_matter_pct | L.organic_matter_pct; C_org como entrada S04 | Laboratorio o estimación derivada identificada | % masa seca → % masa seca | number → number o null | Propuesta; factor metodológico no universal |
| V14 | Densidad aparente / bulk_density_g_cm3 | soil_reference.bulk_density_g_cm3 | S03/S04 ensayo de muestra no disturbada y cálculo | g y cm³ → g/cm³ | number → number o null | Propuesta; sin referencia real |
| V15 | Densidad de partículas / particle_density_g_cm3 | soil_reference.particle_density_g_cm3 | S03/S04 medida externa o estimación explícita | g/cm³ → g/cm³ | number → number o null | Propuesta; 2,65 no valor automático |
| V16 | Porosidad total / total_porosity_pct | derived.total_porosity_pct / calculated.total_porosity_pct | S03/S04 derivada de densidades compatibles | % volumen → % volumen | number → number o null | Propuesta; dependencias no demostradas |
| V17 | Infiltración / infiltration_mm_h | Nombre de salida en tabla S04; sin payload de adquisición | Ensayo de campo y derivación | mm y h; alternativamente L y m² → mm/h | number → number o null | Propuesta |
| V18 | Resistencia a penetración / penetration_resistance_mpa | Nombre de salida en tabla S04; sin payload de adquisición | Ensayo de penetrómetro y derivación | N/mm² → MPa | number → number o null | Propuesta |
| V19 | Aire por volumen de suelo / air_filled_porosity_pct_soil | calculated.air_filled_porosity_pct_soil; derived.air_content_pct ambiguo en S03 | S04 derivado; denominador volumen total | % volumen suelo → % volumen suelo | number → number o null | Bloqueado por VWC/densidades y denominador |
| V20 | Fracción de poros aireados / air_filled_pore_fraction_pct | calculated.air_filled_pore_fraction_pct | S04 derivado; denominador espacio poroso | % poros → % poros | number → number o null | Bloqueado; distinto de V19 |
| V21 | CIC / cec_cmolc_kg | L.cec_cmolc_kg | Laboratorio / derivación de términos compatibles S04 | cmol(+)/kg; entradas específicas mg/kg → cmol(+)/kg | number → number o null | Propuesta; efectiva/potencial no equivalentes |

V01–V02 y V05 son las tres clases directas documentadas del S8; V06–V07 completan cinco registros. La palabra RH del datasheet está en un sensor de suelo: no prueba que mida humedad del aire. V03 se inventaría como medición si se identificase automáticamente con ese registro.

La nota5.2 de S05 p.17 describe humedad mediante pérdida de masa de una muestra de1kg; no demuestra VWC ni adopta por sí sola el denominador de masa seca de θg del anexo. La correspondencia entre esa descripción, el rótulo %RH y la lectura instalada debe aclararse con IoT/fabricante y Agronomía. No convertir automáticamente la lectura en humedad gravimétrica normalizada. Las notas5.1 recomiendan estabilización inicial de al menos2min y mencionan condiciones generales entre−20 y60°C; son condiciones documentadas distintas del rango de temperatura de tabla1, no prueba de desempeño real instalado.

## 3. Resolución, rangos, null y conversiones

Para todas las filas: null significa **sin valor utilizable para esa magnitud**; conservar internamente la causa diferenciada (ausente, inválido, no medido, unidad no resuelta, no calibrado o dependencia insuficiente). Estas causas son propuestas internas, no una ampliación aprobada del DTO. Null no identifica por sí solo la causa ni autoriza completar con cero.

El tipo de proyección `number o null` se aplica a las 21 magnitudes; para auxiliares se conserva el tipo por campo (boolean, string, entero o número) indicado en A01–A09, con ausencia/null según calidad disponible. No interpretar el encabezado de magnitudes como si convirtiera flags o IDs auxiliares en números. Las nueve filas auxiliares son grupos, no nueve variables escalares: calibración y reglas se aplican al campo y fuente pertinentes; un ID o flag no necesita calibración física.

| ID | Precisión conocida / pendiente | Rango técnicamente documentado | Conversión permitida como especificación / calibración requerida |
|---|---|---|---|
| V01 | Resolución Modbus 0,1 °C; exactitud publicada ±5 °C a 25 °C, sin corregirla a ±0,5 | −40 a 80 °C, S05 tabla 1 | raw int16/10 solo si es registro sin decodificar. JSON en °C no vuelve a dividirse. Confirmar equipo/offset; exactitud instalada pendiente |
| V02 | Resolución 0,1 % RH; exactitud publicada ±2% en 0–50 y ±3% en 50–100, interpretación del fabricante | 0–100 % RH reportado, S05 | raw int16/10 solo en frontera Modbus. No convertir % reportado a VWC por identidad; calibración por suelo/profundidad y versión |
| V03 | Sin precisión, rango instrumental ni modelo acreditado | No documentado para un equipo ambiental | Sin conversión/mapeo habilitado. Exigir fuente ambiental identificada |
| V04 | Error de curva y precisión de salida pendientes | No hay rango instrumental calibrado aportado; consistencia física con porosidad debe evaluarse | Curva experimental o gravimetría S04; entradas, profundidad, densidad y vigencia verificadas; no aplicar a y b inventados |
| V05 | Resolución 1 µS/cm; salida equivalente 0,001 dS/m, sin prometer exactitud de 0,001. Ficha: ±3% en 0–10000 y ±5% en 0–20000, bandas superpuestas por aclarar | 0–20000 µS/cm, equivalente 0–20 dS/m solo para ese rango/modelo | CE[dS/m]=CE[µS/cm]/1000 con origen confirmado. Registrar compensación/corrección ya aplicada; no agregarla dos veces ni equiparar métodos de extracto/sonda |
| V06 | Resolución 1 mg/L; exactitud analítica no documentada | Rango físico específico no localizado; uint16 no demuestra rango de medición | Identidad de unidad si validada; conservar estimación y factor real del equipo, sin recalcular por factor supuesto |
| V07 | Resolución 1 mg/L; exactitud analítica no documentada | Rango físico específico no localizado; uint16 no demuestra rango de medición | Igual que V06, con su propio factor/configuración |
| V08–V09 | Precisión/LOD/LOQ dependientes del laboratorio, pendientes | Sin rango instrumental aprobado para integración | Conversión extracto→suelo exige blanco, volumen, dilución, masa seca y método. NO₃-N→NO₃⁻ solo con especie inequívoca y factor S04, sin confundirlo con N total |
| V10 | Precisión/LOD/LOQ pendientes por método | No definido; umbral agronómico no es rango instrumental | Fórmula de extracto S04 solo con insumos/validación; no convertir Olsen a Bray por unidad |
| V11 | Precisión/LOD/LOQ pendientes | No definido | Fórmula de extracto S04 con método; no identificar K con K₂O ni total con intercambiable |
| V12 | Precisión de electrodo/ensayo pendiente | S06 presenta escala 0–14 como referencia; no es ficha de un sensor integrado ni regla universal de rechazo | Sin unidad física a convertir; calibrar electrodo y declarar medio/relación suelo-solución |
| V13 | Método, factor y redondeo pendientes | Sin rango técnico del método integrado | MO≈C_org×factor validado. S03 usa 1,72 y S04 1,724: aproximaciones documentales, no constante de producción aprobada |
| V14 | Error de masa/volumen y precisión pendientes | Sin rango instrumental aprobado | Masa seca/volumen original, ensayo no disturbado; no densidad de muestra remoldeada |
| V15 | Error o incertidumbre de estimación pendiente | Sin rango instrumental aprobado | Preservar medición o supuesto explícito aprobado; no insertar 2,65 por defecto |
| V16 | Propagación de incertidumbre/redondeo pendientes | Consistencia física propuesta 0–100%, no umbral agronómico | 100×(1−ρb/ρp), ρp>0 y densidades compatibles; no recortar resultados incoherentes |
| V17 | Resolución de ensayo/tiempo pendiente | Sin rango instrumental aprobado | Δh/Δt; Δt>0, agua realmente infiltrada; no equivaler tasa inicial/media/estable |
| V18 | Resolución fuerza/área pendiente | Sin rango instrumental aprobado | F/A con A>0; 1 N/mm²=1 MPa. Declarar humedad, profundidad y geometría |
| V19–V20 | Propagación y redondeo pendientes | Consistencia física propuesta: 0≤θv≤P≤100 y P>0 para V20 | V19=P−θv; V20=100×(P−θv)/P. Misma capa/tiempo compatible y VWC validada. Nunca usar V02 sin calibración |
| V21 | Método e incertidumbre pendientes | Sin rango instrumental aprobado | Suma de cationes/acidez compatibles según S04; no mezclar CIC efectiva/potencial ni inferirla desde CE |

Las fórmulas aquí citadas son las de S04, condicionadas a insumos y aceptación científica; esta entrega no las implementa ni aprueba una nueva calibración. No se establecen alarmas agronómicas ni frecuencias obligatorias a partir de ejemplos.

## 4. Variables auxiliares documentadas

Las filas A01–A09 combinan propuestas S03, registros documentados S05 (A01), campos del ejemplo legado S12 (A03–A05) y metadatos de ingesta confirmados por código (A09). No están en el enum FE ni se agregan a BE-03. Para magnitudes auxiliares, precisión efectiva, redondeo y calibración instalada quedan pendientes cuando corresponda; no se exige calibrar IDs, versiones o flags. Null/ausencia conserva falta de fuente o medición inválida, nunca cero automático. Paths anidados como voltage_v, charging, rsrp_dbm o satellites comparten el prefijo del grupo indicado en su fila; no son aliases de campos superiores.

| ID | Paths originales / canónico candidato | Tipo y unidad original → salida candidata | Rango/conversión y fuente |
|---|---|---|
| A01 | sensor_configuration.ec_correction_pct, salinity_factor, tds_factor; offsets Modbus 80–82 | number % / factor adimensional; offsets °C, % reportado, µS/cm | S05 registros 34–36: corrección 0–10% paso0,1; factores 0–1 paso0,01. Defaults 0/0,55/0,50 no prueban configuración actual. No escribir registros ni recalibrar backend |
| A02 | connectivity.signal.csq / signal_csq | integer, índice adimensional | S03: 0–31 válido, 99 desconocido. No publicar 99 como intensidad real; RSSI≈−113+2×CSQ solo para 0–31 y como derivado aproximado |
| A03 | connectivity.signal.rssi_dbm, rsrp_dbm, rsrq_db, sinr_db | number; dBm,dBm,dB,dB → mismas unidades identificadas | Rangos/precisión de módem no aportados. No derivar RSRP/RSRQ/SINR de CSQ; null sin soporte. device.signal_strength legado sin unidad comprobada |
| A04 | device_status.battery.percentage, voltage_v, charging, power_source | number %, number V, boolean, string → forma interna por aprobar | S03 exige ADC/divisor/calibración y curva de batería; no regla lineal voltaje→%. device.battery legado sin semántica garantizada |
| A05 | geolocation.latitude, longitude, altitude_m, accuracy_m, satellites, gps_fix; location.lat/lon legado | number grados/grados/m/m, integer conteo, boolean | Semántica propuesta S03; precisión/GNSS instalado pendientes. Validar lat/lon antes de mapper; no inventar posición ni descartar sensor sin ella |
| A06 | device_status.uptime_seconds, free_heap_bytes, modbus_errors, sensor_connected | number s, number bytes, integer conteo, boolean | Tipos/rangos exactos firmware pendientes; no deducir estado conectado desde una única bandera histórica |
| A07 | seq, msg_id, device_id, sensor_id, schema_version, data_status, time_quality, calibration_id | integer o strings según propuesta; sin unidad | Identificadores/versiones/calidad, no magnitudes. seq puede reiniciar; no prueba identidad global, unicidad ni tenant |
| A08 | soil_reference.measurement_depth_cm, reference_sample_date; entradas de fórmulas S04 | number cm; fecha; masas g/kg, volúmenes cm³/L, tiempos h, fuerza N, área mm², carbono orgánico % y θg g/g | No hay payload real de ensayos ni precision instalada. Conservar base/unidades y compatibilidad espacial/temporal; a/b experimentales sin valores aprobados |
| A09 | timestamp, _receivedAt, _lastSeen, _createdAt | string/null propuesto de adquisición; Date JS→BSON Date generado por ingesta para metadatos | Precisión y política en [FECHAS_PRECISION_BE04.md](FECHAS_PRECISION_BE04.md). _lastSeen es recepción de estado, no última adquisición |

Valores declarados manualmente (instalación fija, densidad de referencia, etc.) llevan esa procedencia aunque sean numéricamente plausibles. Un resultado de laboratorio cargado por una persona conserva origen analítico y agrega el mecanismo de carga; no se convierte en medición del S8 ni en simple valor manual sin método.

## 5. Compatibilidad pendiente con FE/BE-03

| Contrato observado S08 / borrador S11 | Discrepancia | Revisión necesaria, sin alterar PR #3 |
|---|---|---|
| Medida={valor:number o null,unidad:string} | No incluye causa, fuente, especie, método, calibración ni precisión | D04-06: acordar metadatos internos/públicos. No enviar extras contra schemas cerrados de BE-03 |
| humedad con % demo | Ambigua entre V02, V03 y V04 | D04-02: etiquetar semántica y acordar qué serie consume FE. Nunca mezclar RH ambiental o VWC con lectura S8 por compartir % |
| conductividad con dS/m demo | soil.conductivity/readings pueden carecer de unidad; S8 expresa µS/cm | D04-01/03: conversión condicionada y origen/versionado; no decidir escala por magnitud numérica |
| nitrogeno/fosforo/potasio demo mg/kg | N genérico no identifica nitrato; P/K sin fracción/método | D04-04: aprobar significado. S8 sin fuente adicional entrega null, no copiar datos demo |
| Snapshot timestamp único y seis medidas requeridas | Ensayos de distinta fecha no son snapshot S8; una última válida por variable puede mezclar instantes | D04-05/06: preferir como propuesta frame único parcial; enriquecimiento y fechas por variable necesitan acuerdo |
| Histórico: unidad única, variable de seis valores, puntos timestamp/valor | No representa mezcla de unidad, método, profundidad, precisión o procedencia | D04-07: segmentar o bloquear combinación incompatible; no añadir nuevos filtros/rutas por inferencia |
| Sin pH, salinidad/TDS, ambiente ni auxiliares en enum | Catálogo más amplio que UI | D04-08: postergar ampliación o aprobar cambio coordinado DTO/OpenAPI/FE; conservar esos datos en bruto |
| Fechas string; borrador BE-03 permite más de 3 decimales | Date.parse/Date y BSON Date no conservan automáticamente submilisegundos | D04-09 y D03-14: resolver comparación, almacenamiento y salida antes de implementar |

Los formatos y transformaciones permitidos por evidencia se detallan en [MATRIZ_NORMALIZACION_BE04.md](MATRIZ_NORMALIZACION_BE04.md); no hay conversor ejecutable en esta entrega.

**Unidad original y unidad destino son diferentes:** si la unidad destino ya está acordada, `valor:null` puede acompañarse de esa unidad canónica aun cuando no se conozca la original, sin convertir un número ni afirmar la escala de origen. Si también faltan acuerdo de magnitud/unidad destino, no inventarlos ni usar unidad:null contra BE-03: D04-06 debe resolver la representación. El catálogo no aprueba todavía esas unidades productivas por mostrar las demo.
