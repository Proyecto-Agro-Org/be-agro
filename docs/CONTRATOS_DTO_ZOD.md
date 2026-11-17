# Diseño de DTOs y validación Zod para BE-03

**Estado:** documentación técnica en revisión. Estos bloques no se importan, compilan ni ejecutan en el backend. Zod/TypeScript no están instalados; no se migra JavaScript ni se elige una versión definitiva.
**Referencia:** [OpenAPI 3.1](openapi.json), [informe BE-03](../INFORME_BE03_CONTRATOS_API.md).

## 1. Fronteras y reglas

HTTP → extracción de params/query/body → Zod → DTORequest normalizado → controller → service → repository; mapper → DTOResponse. Ni tipos ni validación de forma verifican pertenencia: esa regla usa sesión/catálogo confiables. Modelos BSON no se exponen.

Los ejemplos usan la API documentada de Zod 4 como diseño; versión/instalación y pruebas reales quedan para BE-05/BE-07. No hay afirmación de que el código se ejecutó. Referencia: [Zod API](https://zod.dev/api).

- IDs públicos: strings opacos no vacíos ni compuestos solo de espacios; conservar valor exacto. Sin UUID/ObjectId obligatorio, coerción de números o equivalencia por prefijo.
- Query HTTP: strings, una ocurrencia por clave. Rechazar repetidos y claves desconocidas es propuesta explícita; el mock solo garantiza multiplicidad de campo_id.
- Extraer query desde URLSearchParams conservando getAll antes de construir un objeto. No aceptar arrays/objetos desde parser Express ni elegir el primer valor silenciosamente.
- limit: decimal entero positivo; no usar coerción que convierta ""/espacios/null en cero. Salida DTO number; entrada HTTP string.
- Fechas: perfil RFC3339 restringido propuesto, con calendario válido, segundos y zona explícita, T/Z mayúsculas y sin segundos intercalares; salida UTC Z. No se afirma aceptar todo RFC3339. desde<hasta para histórico según especificación y, como propuesta pendiente, para alertas si hay ambos límites. UTC/ISO no implica elegir adquisición versus recepción: eso depende de BE-02/04.
- null y ausencia son distintos: campo opcional se omite; campo requerido nullable está presente con null. Las seis medidas del sensor siempre presentes cuando ultima_medicion no es null.
- No conversiones de unidad, umbrales, reglas de desconexión ni asignación de NPK en estos esquemas. unidad sigue string.
- Propuesta de respuestas cerradas a campos extra en OpenAPI/Zod: no es una propiedad del compilador TypeScript del frontend; validar extensiones con FE antes de integrar.
- GET de negocio sin body; auth/tenant no vienen de body/query. Headers pertenecen al transporte y no se propagan a services como Request Express.

## 2. DTOs comunes como tipos TypeScript

```typescript
type PublicId = string;
type UtcDateTime = string;
type DateTimeWithZone = string;
type Estado = "conectado" | "desconectado";
type Variable = "humedad" | "temperatura" | "conductividad"
  | "nitrogeno" | "fosforo" | "potasio";
type TipoAlerta = "tecnica" | "agronomica";
type EstadoAlerta = "activa" | "resuelta";
type Severidad = "alta" | "media" | "baja";
interface Medida { valor: number | null; unidad: string }
interface Ubicacion { lat: number; lon: number }
interface Cliente { cliente_id: PublicId; nombre: string }
interface Usuario {
  usuario_id: PublicId; nombre: string; email: string; cliente_id: PublicId;
}
type UsuarioLogin = Pick<Usuario, "nombre" | "email"> &
  Partial<Pick<Usuario, "usuario_id" | "cliente_id">>;
interface Campo { campo_id: PublicId; nombre: string; cliente_id: PublicId }
interface Area { area_id: PublicId; nombre: string; campo_id: PublicId }
type AreaApi = Omit<Area, "campo_id"> & Partial<Pick<Area, "campo_id">>;
interface Sensor { device_id: PublicId; nombre: string; area_id: PublicId }
interface Conteos {
  sensores: number; conectados: number; desconectados: number;
  alertas_activas: number;
}
interface AreaResumen extends AreaApi, Conteos {
  ultima_actualizacion: UtcDateTime | null;
}
interface AreaDashboard extends AreaApi, Conteos {}
interface SensorDeArea {
  device_id: PublicId; nombre: string; estado: Estado;
  ultima_comunicacion: UtcDateTime | null;
  ubicacion: Ubicacion | null; alertas_activas: number;
}
type UltimaMedicion = { timestamp: UtcDateTime } & Record<Variable, Medida>;
interface SensorDetalle extends Sensor {
  area_nombre: string; estado: Estado;
  ultima_comunicacion: UtcDateTime | null;
  ubicacion: Ubicacion | null; ultima_medicion: UltimaMedicion | null;
}
interface HistoricoRespuesta extends Sensor {
  area_nombre: string; variable: Variable; unidad: string;
  puntos: { timestamp: UtcDateTime; valor: number | null }[];
  truncado: boolean;
}
interface SensorMapa extends Sensor {
  area_nombre: string; estado: Estado; ubicacion: Ubicacion | null;
  ultima_comunicacion: UtcDateTime | null;
  ultima_medicion: {
    timestamp: UtcDateTime; humedad: Medida; temperatura: Medida;
  } | null;
}
interface Alerta {
  alerta_id: PublicId; device_id: PublicId; sensor_nombre: string;
  area_id: PublicId; area_nombre: string; tipo: TipoAlerta;
  severidad: Severidad; descripcion: string;
  timestamp: UtcDateTime; estado: EstadoAlerta;
}
type ErrorCode = "VALIDATION_ERROR" | "UNAUTHENTICATED" | "ACCESS_DENIED"
  | "RESOURCE_NOT_FOUND" | "INTERNAL_ERROR";
interface ErrorResponse { error: { code: ErrorCode; message: string } }
interface LegacyErrorResponse { error: string }
```

Los tipos number anteriores deben ser finitos y los conteos enteros no negativos al validar JSON. Son restricciones de diseño, no validación automática de las interfaces.

## 3. Request y Response por operación

```typescript
type CampoQuery = { campo_id: PublicId };
type AreaParams = { areaId: PublicId };
type SensorParams = { deviceId: PublicId };
interface HistoricoQuery extends CampoQuery {
  variable: Variable; desde: DateTimeWithZone; hasta: DateTimeWithZone;
  limit?: number; // default propuesto 500; máximo 1000 observado en mock
}
interface AlertasQuery extends CampoQuery {
  area_id?: PublicId; tipo?: TipoAlerta; estado?: EstadoAlerta;
  severidad?: Severidad; desde?: DateTimeWithZone; hasta?: DateTimeWithZone;
  limit?: number; // default 50; máximo 200 observados en mock
}
// HistoricoQuery/AlertasQuery representan la query decodificada antes del default.
// El DTO entregado a la aplicación después de validar/normalizar exige limit.
type HistoricoQueryNormalizada = Omit<HistoricoQuery, "limit"> & { limit: number };
type AlertasQueryNormalizada = Omit<AlertasQuery, "limit"> & { limit: number };
type GetHealthRequest = undefined; // params/query/body no aplican
type GetHealthResponse = { status: "ok" };
type PostLoginRequest = { body: { email: string; password: string } };
type PostLoginResponse = {
  token: string; usuario?: UsuarioLogin; cliente?: Cliente;
};
type GetDashboardRequest = { query: CampoQuery };
type GetDashboardResponse = {
  resumen: { areas: number } & Conteos;
  areas: AreaDashboard[]; ultimas_alertas: Alerta[];
  ultima_actualizacion: UtcDateTime | null;
};
type GetAreasRequest = { query: CampoQuery };
type GetAreasResponse = { areas: AreaResumen[] };
type GetAreaRequest = { params: AreaParams; query: CampoQuery };
type GetAreaResponse = AreaApi;
type GetAreaSensoresRequest = { params: AreaParams; query: CampoQuery };
type GetAreaSensoresResponse = { sensores: SensorDeArea[] };
type GetSensorRequest = { params: SensorParams; query: CampoQuery };
type GetSensorResponse = SensorDetalle; // incluye última medición
type GetHistoricoRequest = { params: SensorParams; query: HistoricoQueryNormalizada };
type GetHistoricoResponse = HistoricoRespuesta;
type GetMapaRequest = { query: CampoQuery };
type GetMapaResponse = { sensores: SensorMapa[] };
type GetAlertasRequest = { query: AlertasQueryNormalizada };
type GetAlertasResponse = { total: number; limit: number; alertas: Alerta[] };

// Cobertura de campos y sesión observados SOLO en MSW, sin ruta productiva aprobada:
type GetCamposRequest = undefined; // mock sin params/query/body; Bearer de transporte
type GetCamposResponse = { campos: Campo[] };
type PostGoogleDemoRequest = undefined;
type PostGoogleDemoResponse = PostLoginResponse;
type PostDemoSesionRequest = { body: { token: string } };
type PostDemoSesionResponse = { usuario: Usuario; cliente: Cliente };
```

PostLoginResponse equivale a LoginResponse de OpenAPI; se mantiene ese nombre de schema por legibilidad. GetCamposResponse es componente aislado, no aprobación de GET /campos. No crear DTORequest de logout/me reales antes de acordar flujo/transporte. Los DTOs demo describen MSW, no deben copiarse al backend de producción.

## 4. Esquemas Zod de diseño

Estos bloques cubren forma de request/response de las diez operaciones descritas en paths, más componentes de campos/demo. La extracción de headers, multiplicidad, rechazo de body GET y comprobaciones de pertenencia son pasos separados: no atribuirlos a z.object.

```typescript
import * as z from "zod"; // EJEMPLO DOCUMENTAL; no instalar ni importar en src

const PublicIdSchema = z.string().min(1).regex(/\S/);
const InputDateSchema = z.iso.datetime({ offset: true }).regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
);
const UtcDateSchema = z.iso.datetime().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
);
const CountSchema = z.number().int().nonnegative();
const FiniteNumberSchema = z.number().refine(Number.isFinite);
const EstadoSchema = z.enum(["conectado", "desconectado"]);
const VariableSchema = z.enum([
  "humedad", "temperatura", "conductividad", "nitrogeno", "fosforo", "potasio"
]);
const TipoAlertaSchema = z.enum(["tecnica", "agronomica"]);
const EstadoAlertaSchema = z.enum(["activa", "resuelta"]);
const SeveridadSchema = z.enum(["alta", "media", "baja"]);
const MedidaSchema = z.strictObject({
  valor: FiniteNumberSchema.nullable(), unidad: z.string()
});
const UbicacionSchema = z.strictObject({
  lat: FiniteNumberSchema.min(-90).max(90),
  lon: FiniteNumberSchema.min(-180).max(180)
});
const ClienteSchema = z.strictObject({
  cliente_id: PublicIdSchema, nombre: z.string()
});
const UsuarioSchema = z.strictObject({
  usuario_id: PublicIdSchema, nombre: z.string(),
  email: z.email(), cliente_id: PublicIdSchema
});
const UsuarioLoginSchema = z.strictObject({
  nombre: z.string(), email: z.email(),
  usuario_id: PublicIdSchema.optional(), cliente_id: PublicIdSchema.optional()
});
const CampoSchema = z.strictObject({
  campo_id: PublicIdSchema, nombre: z.string(), cliente_id: PublicIdSchema
});
const AreaApiSchema = z.strictObject({
  area_id: PublicIdSchema, nombre: z.string(), campo_id: PublicIdSchema.optional()
});
const sensorFields = {
  device_id: PublicIdSchema, nombre: z.string(), area_id: PublicIdSchema
};
const countFields = {
  sensores: CountSchema, conectados: CountSchema,
  desconectados: CountSchema, alertas_activas: CountSchema
};
const AreaResumenSchema = z.strictObject({
  ...AreaApiSchema.shape, ...countFields,
  ultima_actualizacion: UtcDateSchema.nullable()
});
const AreaDashboardSchema = z.strictObject({
  ...AreaApiSchema.shape, ...countFields
});
const SensorDeAreaSchema = z.strictObject({
  device_id: PublicIdSchema, nombre: z.string(), estado: EstadoSchema,
  ultima_comunicacion: UtcDateSchema.nullable(),
  ubicacion: UbicacionSchema.nullable(), alertas_activas: CountSchema
});
const UltimaMedicionSchema = z.strictObject({
  timestamp: UtcDateSchema,
  humedad: MedidaSchema, temperatura: MedidaSchema,
  conductividad: MedidaSchema, nitrogeno: MedidaSchema,
  fosforo: MedidaSchema, potasio: MedidaSchema
});
const GetSensorResponseSchema = z.strictObject({
  ...sensorFields, area_nombre: z.string(), estado: EstadoSchema,
  ultima_comunicacion: UtcDateSchema.nullable(),
  ubicacion: UbicacionSchema.nullable(),
  ultima_medicion: UltimaMedicionSchema.nullable()
});
const PuntoHistoricoSchema = z.strictObject({
  timestamp: UtcDateSchema, valor: FiniteNumberSchema.nullable()
});
const GetHistoricoResponseSchema = z.strictObject({
  ...sensorFields, area_nombre: z.string(), variable: VariableSchema,
  unidad: z.string(), puntos: z.array(PuntoHistoricoSchema).max(1000),
  truncado: z.boolean()
});
const SensorMapaSchema = z.strictObject({
  ...sensorFields, area_nombre: z.string(), estado: EstadoSchema,
  ubicacion: UbicacionSchema.nullable(),
  ultima_comunicacion: UtcDateSchema.nullable(),
  ultima_medicion: z.strictObject({
    timestamp: UtcDateSchema, humedad: MedidaSchema, temperatura: MedidaSchema
  }).nullable()
});
const AlertaSchema = z.strictObject({
  alerta_id: PublicIdSchema, device_id: PublicIdSchema,
  sensor_nombre: z.string(), area_id: PublicIdSchema, area_nombre: z.string(),
  tipo: TipoAlertaSchema, severidad: SeveridadSchema, descripcion: z.string(),
  timestamp: UtcDateSchema, estado: EstadoAlertaSchema
});
const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(["VALIDATION_ERROR", "UNAUTHENTICATED", "ACCESS_DENIED",
      "RESOURCE_NOT_FOUND", "INTERNAL_ERROR"]),
    message: z.string()
  })
});
const LegacyErrorResponseSchema = z.strictObject({ error: z.string() });

const GetHealthRequestSchema = z.undefined();
const GetHealthResponseSchema = z.strictObject({ status: z.literal("ok") });
const PostLoginRequestSchema = z.strictObject({
  body: z.strictObject({ email: z.email(), password: z.string().min(1) })
});
const PostLoginResponseSchema = z.strictObject({
  token: z.string().min(1), usuario: UsuarioLoginSchema.optional(),
  cliente: ClienteSchema.optional()
});
const CampoQuerySchema = z.strictObject({ campo_id: PublicIdSchema });
const AreaParamsSchema = z.strictObject({ areaId: PublicIdSchema });
const SensorParamsSchema = z.strictObject({ deviceId: PublicIdSchema });
const GetDashboardRequestSchema = z.strictObject({ query: CampoQuerySchema });
const GetAreasRequestSchema = z.strictObject({ query: CampoQuerySchema });
const GetAreaRequestSchema = z.strictObject({
  params: AreaParamsSchema, query: CampoQuerySchema
});
const GetAreaSensoresRequestSchema = GetAreaRequestSchema;
const GetSensorRequestSchema = z.strictObject({
  params: SensorParamsSchema, query: CampoQuerySchema
});
const GetMapaRequestSchema = z.strictObject({ query: CampoQuerySchema });

const GetDashboardResponseSchema = z.strictObject({
  resumen: z.strictObject({ areas: CountSchema, ...countFields }),
  areas: z.array(AreaDashboardSchema), ultimas_alertas: z.array(AlertaSchema).max(5),
  ultima_actualizacion: UtcDateSchema.nullable()
});
const GetAreasResponseSchema = z.strictObject({ areas: z.array(AreaResumenSchema) });
const GetAreaResponseSchema = AreaApiSchema;
const GetAreaSensoresResponseSchema = z.strictObject({
  sensores: z.array(SensorDeAreaSchema)
});
const GetMapaResponseSchema = z.strictObject({ sensores: z.array(SensorMapaSchema) });
const GetAlertasResponseSchema = z.strictObject({
  total: CountSchema, limit: z.number().int().min(1).max(200),
  alertas: z.array(AlertaSchema).max(200)
}).refine(v => v.alertas.length <= v.limit && v.total >= v.alertas.length,
  "Total/límite inconsistentes");

// Sobre query escalar ya extraída; rechazar repetidos ANTES de llegar aquí.
const limitFromHttp = (max: number, fallback: number) =>
  z.string().regex(/^[1-9]\d*$/).transform(Number)
    .pipe(z.number().int().min(1).max(max)).default(fallback);

// Contrato de helper pendiente de implementación/pruebas, NO implementación real.
// Compara instantes con offset y toda la precisión fraccionaria admitida.
// Date.parse por sí solo pierde fracciones inferiores al milisegundo.
declare function compararInstantesRfc3339(a: string, b: string): -1 | 0 | 1;

const HistoricoQuerySchema = z.strictObject({
  campo_id: PublicIdSchema, variable: VariableSchema,
  desde: InputDateSchema, hasta: InputDateSchema,
  limit: limitFromHttp(1000, 500)
}).refine(v => compararInstantesRfc3339(v.desde, v.hasta) < 0, "Rango inválido");

const AlertasQuerySchema = z.strictObject({
  campo_id: PublicIdSchema, area_id: PublicIdSchema.optional(),
  tipo: TipoAlertaSchema.optional(), estado: EstadoAlertaSchema.optional(),
  severidad: SeveridadSchema.optional(),
  desde: InputDateSchema.optional(), hasta: InputDateSchema.optional(),
  limit: limitFromHttp(200, 50)
}).refine(v => !v.desde || !v.hasta ||
  compararInstantesRfc3339(v.desde, v.hasta) < 0, "Rango inválido");

const GetHistoricoRequestSchema = z.strictObject({
  params: SensorParamsSchema, query: HistoricoQuerySchema
});
const GetAlertasRequestSchema = z.strictObject({ query: AlertasQuerySchema });
const GetCamposRequestSchema = z.undefined(); // solo mock/ruta real pendiente
const GetCamposResponseSchema = z.strictObject({ campos: z.array(CampoSchema) });
const PostGoogleDemoRequestSchema = z.undefined();
const PostGoogleDemoResponseSchema = PostLoginResponseSchema;
const PostDemoSesionRequestSchema = z.strictObject({
  body: z.strictObject({ token: z.string().min(1) })
});
const PostDemoSesionResponseSchema = z.strictObject({
  usuario: UsuarioSchema, cliente: ClienteSchema
});
```

La entrada de HistoricoQuerySchema/AlertasQuerySchema tiene limit como string opcional; su salida contiene number requerido con default. En §3, HistoricoQuery/AlertasQuery describen la query decodificada antes de aplicar el default, y las variantes *Normalizada usadas por GetHistoricoRequest/GetAlertasRequest describen el DTO de aplicación. Para el service se recomendaría `z.output<typeof HistoricoQuerySchema>` (o el equivalente de alertas), no z.input. OpenAPI conserva limit opcional en los parámetros HTTP y lo exige únicamente en los componentes de DTO normalizado. El keyword JSON Schema `default` es una anotación: por sí solo no inserta ni transforma datos.

La interpretación final de email/ID y rechazo de extras debe acordarse con FE. Los mocks no validan email con z.email, fechas con este calendario estricto ni todos los enums de alertas; esos son cambios de validación de diseño, no compatibilidad runtime ya demostrada.

**Precisión pendiente (D03-14):** los patrones permiten más de tres decimales. `Date.parse` convierte tanto `2026-11-16T12:00:00.0001Z` como `2026-11-16T12:00:00.0002Z` al mismo milisegundo, aunque el primero es anterior. Se retira esa comparación inexacta del diseño Zod y se declara el contrato de un helper pendiente. No se restringe silenciosamente el formato público ni se afirma disponer de ese helper; deberá implementarse/probarse con precisión suficiente o acordarse otra precisión con FE antes de implementar rangos. Estos bloques siguen siendo diseño incompleto, no código listo para ejecutar.

## 5. Reglas semánticas fuera de la forma JSON

- Comparar fechas como instantes, no strings locales. Histórico ascendente con límite aplicado y truncado fiable; regla de desempate interno sin exponer BSON.
- desde<hasta: el mock histórico permite igualdad; rechazarla sigue la especificación backend y requiere prueba de integración posterior.
- Propuesta de rango inclusivo [desde,hasta], conforme filtros actuales; política definitiva debe acordarse con FE, incluidos empates y truncado.
- Si puntos adicionales existen, truncado=true; no derivarlo únicamente de puntos.length===limit.
- Alertas: total antes de límite y después de filtros; orden alta→media→baja y fecha descendente. Dashboard usa otro criterio observado: cinco por fecha e incluye resueltas.
- Counts consistentes: conectados+desconectados=sensores; totales desde la misma fuente autorizada. No duplicar reglas en controllers.
- LoginRespuesta mínima con token es compatible de forma pero no alcanza al selector real de campos ni recuperación; no confundir con auth real.
- IdentidadSesion usuario.cliente_id debe coincidir con cliente.cliente_id. Prueba de existencia/pertenencia es del backend, no del schema de strings.
- Ubicación inválida se mapea a null, no se excluye el sensor del resultado. Un schema de respuesta rechaza coordenadas fuera de rango, no reemplaza al mapper.
- No usar _receivedAt o _lastSeen como adquisición sin decisión BE-04; no fusionar lecturas de distintos instantes como si fueran un snapshot único.

## 6. Errores y transporte

Los errores se serializan por un handler central a ErrorResponse; Zod no debería filtrar sus issues internos, objetos recibidos ni stack. Asignar VALIDATION_ERROR 400, UNAUTHENTICATED 401, RESOURCE_NOT_FOUND 404 e INTERNAL_ERROR 500. ACCESS_DENIED 403 queda reservado a una denegación explícita aprobada, sin añadir roles ni usarlo para recursos de otro cliente.

Health mantiene su LegacyErrorResponse real para CORS/500 en esta etapa. El cliente actual trata error como string, por lo que integrar ErrorResponse exige adaptar leerMensajeError y sus pruebas. No enviar ambos formatos de negocio como una unión indefinida para ocultar esa incompatibilidad.

Accept: application/json; Content-Type: application/json al enviar body; Authorization: Bearer en consultas privadas según transporte observado. Origin/CORS es transporte del navegador y no identidad. Ningún secreto se documenta como ejemplo real. No se añade Cookie, refresh token, id_token Google o endpoints de sesión mientras sigan pendientes.
