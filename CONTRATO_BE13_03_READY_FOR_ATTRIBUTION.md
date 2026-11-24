# BE13-03 — Contrato `ready-for-attribution`

## Estado

IMPLEMENTADO y PROBADO offline con dobles de autoridades. No está compuesto en la aplicación, no tiene rutas, no persiste y no constituye aprobación productiva de registro de dispositivos, política temporal, catálogo BE-04 ni autenticación de hardware.

## Entrada

```ts
gate.evaluate(candidate: ProtectedMeasurementCandidate, selection: { field: string }): Promise<TrustGateResult>
```

- `candidate` debe ser **el mismo objeto** emitido por el mapper BE13-02 (`createProtectedIngestMapper`). Se verifica por identidad mediante `isIssuedCandidate` (`src/iot/protected-candidate.registry.ts`). Copias (`structuredClone`, spread, JSON, `Object.freeze({...})`), documentos legacy, documentos protegidos sin mapear, requests HTTP, eventos MQTT u objetos arbitrarios → `invalid-candidate`.
- Además se revalida su forma (`gateCandidateSchema`, estricto): solo `measurement-candidate` / `telemetry` / `eligibleForMeasurementMapping: true`. Un `technical-event-candidate` → `invalid-candidate`.
- `selection.field` (estricto, solo esa clave) nombra un campo técnico propio del payload. Elegir un campo no atribuye nada: la magnitud y la unidad solo provienen del catálogo inyectado. El caller no puede aportar `clientId`, `sensorId`, instante ni ningún otro dato de atribución.

## Composición

```ts
createAttributionTrustGate(ports: TrustGatePorts, options: { realm, authorityTimeoutMs? })
```

- `realm ∈ development | test | preview | production` (mismo enum que BE-09/BE-12).
- `authorityTimeoutMs` (1–60000, por defecto 5000) es una cota operativa ante autoridades que no responden. **No es una tolerancia temporal de atribución.**
- Cualquier puerto omitido usa un adapter bloqueante (`src/adapters/trust-gate-blocking.adapters.ts`). Un puerto presente sin el método requerido → `TypeError` en construcción. Los métodos se capturan una sola vez.

## Puertos

| Puerto | Método | Entrada | Salida aceptada |
| --- | --- | --- | --- |
| A. Dispositivo | `devices.resolve` | `{realm, sourceId, device, limit:2}` | `{realm, devices: PhysicalDevice[] ≤2}` (schema BE-11 `physicalDeviceSchema`) |
| B. Asociación | `associations.findAt` | `{realm, physicalDeviceId, at, limit:2}` | `{realm, complete:true, records: SensorDeviceAssociation[] ≤2}` (schema BE-11; `active ⇔ validTo=null`; `validFrom<validTo`) |
| C. Temporal | `temporal.decide` | `{realm, eventId, sourceId, physicalDeviceId, timestamps}` | `trusted{at, clock, policyRevision}` \| `untrusted{reason:'untrusted-clock'}` \| `unresolved` |
| D. Catálogo | `catalogue.evaluate` | `{realm, sourceId, physicalDeviceId, sensorId, field, valueKind, at}` | `approved{field, magnitude, unit, catalogueRevision}` \| `unknown-magnitude` \| `incompatible-unit` |
| E. Hardware | `hardware.verify` | `{realm, eventId, sourceId, device, physicalDeviceId, dataOriginDeclared}` | `verified{physicalDeviceId, origin, method, attestationRevision}` \| `unverified` |

Toda respuesta lleva `realm` y se valida con Zod estricto (campos extra rechazados). Las consultas entregadas a los puertos están congeladas y nunca contienen `clientId`.

## Resultado `ready-for-attribution`

```ts
{
  status: 'ready-for-attribution',
  realm, eventId, sourceId,
  device: { kind, value },          // clave técnica, nunca clientId
  physicalDeviceId,                  // autoridad A
  clientId, fieldId, areaId, sensorId, associationId,   // SOLO de la asociación histórica B en authorizedAt
  association: { validFrom, validTo },
  authorizedAt, clock,               // autoridad C; igual a uno de los relojes del candidate
  field, magnitude, unit,            // autoridad D; sin conversión
  value: number | null,              // copia literal: 0 es 0, null es null; missingReason NO se infiere
  timestamps: { receivedAt, persistedAt },
  provenance: { technicalIdentityAuthorization:'external-capability', payloadIntegrity:'not-attested',
                dataOriginDeclared, hardware: { status:'verified', origin, method } },
  revisions: { deviceVersion, associationId, associationRevision, temporalPolicyRevision,
               catalogueRevision, hardwareAttestationRevision },
  revalidation: 'required'
}
```

Profundamente congelado, sin referencias a objetos de autoridades ni al payload. No contiene `attributedAt`, `missingReason`, `persistedAt` obligatorio ni `provenance` BE-12: **no es `TrustedMeasurementEvent` ni `AttributionResult`**.

## Resultado `quarantined`

```ts
{ status: 'quarantined', reason: TrustGateQuarantineCode, eventId: string | null }
```

`eventId` solo se informa si la entrada era un candidate emitido válido. Sin mensajes, stacks, payload ni diagnósticos de adapters.

| Código | Causa |
| --- | --- |
| `invalid-candidate` | No es candidate emitido por BE13-02, no es medición, o selección inválida |
| `absent-field` | El campo seleccionado no existe como propiedad propia del payload |
| `invalid-value` | El valor no es número finito ni `null` |
| `unresolved-device` | Autoridad A sin coincidencias |
| `ambiguous-device` | Más de un dispositivo para la clave |
| `unverified-device` | `verification !== 'verified'` |
| `inactive-device` | `lifecycle !== 'active'` (estado actual; ver limitaciones) |
| `unverified-hardware` | Autoridad E no verifica |
| `unresolved-time` | Autoridad C no puede decidir |
| `untrusted-clock` | Autoridad C declara reloj no confiable |
| `missing-association` | Ninguna ventana `[validFrom, validTo)` contiene el instante |
| `overlapping-association` | Más de una ventana contiene el instante |
| `stale-association` | La asociación cambió entre la primera lectura y la revalidación |
| `stale-resolution` | Dispositivo, hardware, política temporal o catálogo cambiaron entre lecturas |
| `unapproved-magnitude` | Catálogo no reconoce el campo/magnitud |
| `incompatible-unit` | Catálogo rechaza la unidad |
| `realm-mismatch` | Respuesta válida pero de otro realm |
| `contradictory-authority` | Respuesta bien formada pero inconsistente (otra clave/fuente/dispositivo, ventana que no contiene el instante, instante ajeno a los relojes del candidate o posterior a la recepción, origen físico/simulado contradictorio, campo distinto) |
| `invalid-authority-response` | Tipo inválido, campos extra, página incompleta, getters/proxies hostiles |
| `dependency-error` | La autoridad lanza, rechaza o no responde dentro del timeout |
| `internal-error` | Fallo no previsto del gate |

## Orden de evaluación

1. Identidad y forma del candidate; selección y valor.
2. A — dispositivo.
3. E — hardware/procedencia.
4. C — instante autorizado.
5. B — asociación histórica en ese instante.
6. D — catálogo.
7. Segunda lectura de A, E, C, B, D y comparación canónica.
8. Construcción del resultado congelado.

El primer fallo detiene la evaluación; no hay fallback a otra autoridad ni a otro reloj.
