# BE13-10A — Framework de políticas de seguridad operativa

## Resumen

BE13-10A prepara los contratos para las decisiones humanas pendientes de la gobernanza operativa **sin tomarlas**: proveedor de identidad, mapeo rol→capacidad, separación de funciones, expiración y recuperación de leases, autoridad temporal, retención del audit con legal hold y verificación de evidencia. Cada política es un puerto inyectado; los defaults son placeholders bloqueantes; la readiness nunca declara Production. Offline: sin endpoints, sin workers, sin env, sin lecturas de reloj, sin cambios de esquema Mongo, `app.ts` intacto.

Rama `feature/be13-10a-security-policy-framework` (solo local, sin upstream), worktree `.local-consolidacion/be13-10a`, base `dev` `98dd2d85b2da9a8a6b915cb7d1a2f972f0eefcec` (merge de BE13-09, PR #29).

Contratos: `CONTRATO_BE13_10A_IDENTITY.md`, `CONTRATO_BE13_10A_CAPABILITIES.md`, `CONTRATO_BE13_10A_LEASE_POLICY.md`, `CONTRATO_BE13_10A_RETENTION.md`, `CONTRATO_BE13_10A_EVIDENCE_VERIFICATION.md`. ADRs pendientes: `ADR_BE13_10A_IDP_SELECTION_PENDING.md`, `ADR_BE13_10A_LEASE_EXPIRY_PENDING.md`, `ADR_BE13_10A_RETENTION_PENDING.md`. Decisiones: `MATRIZ_DECISIONES_HUMANAS_BE13.md`.

## Archivos

| Archivo | Rol |
| --- | --- |
| `src/iot/operations-security-policy.contracts.ts` | Puertos: `OperatorIdentityProvider`, `OperatorCapabilityMappingPolicy`, `SeparationOfDutiesPolicy`, `OperationsTimeAuthority`, `ReplayLeasePolicy`, `ReplayLeaseStore`, `AuditRetentionAuthority`, `LegalHoldAuthority`, `ResolutionEvidenceVerifier`; bundle, governor y readiness |
| `src/services/operations-security-policy.service.ts` | `createOperationsSecurityPolicyBundle`, `describeSecurityPolicyReadiness`, governor de leases |
| `src/adapters/ingestion-production-placeholders.ts` | `createBlockingSecurityPolicies()` (8 placeholders registrados como bloqueantes) |
| `test-support/be13-10a-policy.fixtures.js` | Políticas sintéticas TEST_ONLY y lease store en memoria con CAS |
| `test/be13-10a-security-policy.test.js` | 39 pruebas (I, M, S, L, R, E, readiness, bundle, integración BE13-09) |
| `test/be13-10a-adversarial.test.js` | 10 vectores (X1–X10) |

## Flujo de autorización con el bundle

credencial opaca → `OperatorIdentityProvider` (identidad: subject, issuer, atributos **del proveedor**, realm) → realm = bundle → `OperatorCapabilityMappingPolicy` (capacidades desde atributos confiables) → capacidad pedida ∈ capacidades → `SeparationOfDutiesPolicy` (solo `permit` explícito) → `OperatorPrincipal` (`realms = [realm]`). `bundle.authorization` es un `OperatorAuthorizationPort` compatible con el bootstrap de BE13-09 (prueba de integración: replay real con el bundle).

## Supuestos conservadores documentados

| Supuesto | Motivo |
| --- | --- |
| El `subject` debe usar el charset seguro del audit (`[A-Za-z0-9:_./-]`); un email no es subject válido | Una identidad que no puede auditarse no puede operar; el adapter del IdP deberá mapear a un id opaco |
| Un conflicto de SoD deniega **todas** las capacidades de ese operador | Lo más restrictivo; si el conflicto debe limitarse a la capacidad en conflicto es decisión humana |
| SoD dinámico (mismo operador sobre la misma entrada) no se modela | Requiere historial de audit y reglas no decididas |
| Respuesta malformada del verificador → `UNVERIFIED`, no `REJECTED` | Rechazar es una afirmación del verificador; la falla no lo es |
| El verificador de evidencia **no** se conecta al `resolve` de BE13-09 | Exigir `VERIFIED` cambia la semántica de resolve: decisión humana |
| La retención por stream (`AuditRetentionAuthority`) es independiente de la declaración estática `AuditRetentionPolicy` de BE13-09 | No cambiar la readiness de BE13-09 |
| El governor de leases no se conecta al replay de BE13-09 ni se persiste en Mongo | Fase 36 (sin esquema nuevo) y expiración no decidida |

## Hallazgos y correcciones

| ID | Severidad | Hallazgo | Corrección |
| --- | --- | --- | --- |
| H1 | BAJO | `describeSecurityPolicyReadiness` lanzaba ante un getter hostil en una dependencia (X10) | Acceso envuelto: getter/proxy hostil → `MISSING` |
| H2 | MEDIO (heredado) | S7 de BE13-09: `releaseLease` no exige propiedad ni expiración | **Contrato listo** (`ReplayLeaseGovernor`: propiedad por identidad autenticada, expiración solo por política con tiempo confiable, CAS). **Sigue abierto en runtime**: el replay de BE13-09 no usa el governor; falta persistir propietario/`acquiredAt` en la cuarentena y conectarlo (BE13-10B), después de decidir la expiración |
| H3 | INFORMATIVO | Un comentario del contrato contenía el literal `Date.now` y disparaba el escaneo de fuentes (X9) | Redacción ajustada; el código no lee el reloj |

## Readiness

`describeSecurityPolicyReadiness` reporta las 8 políticas como `MISSING`, `BLOCKED` (placeholder) o `INJECTED_UNVERIFIED`. `policyTestReady` solo indica que todo fue inyectado (sintético incluido). `productionReady` es el literal `false`. Limitaciones fijas: `IDP_SELECTION_PENDING`, `ROLE_MAPPING_PENDING`, `SEPARATION_OF_DUTIES_RULES_PENDING`, `LEASE_EXPIRY_PENDING`, `TIME_AUTHORITY_PENDING`, `EVIDENCE_VERIFICATION_PENDING`, `AUDIT_RETENTION_PENDING`, `LEGAL_HOLD_PROCESS_PENDING`, `WORM_NOT_PROVIDED`, `DYNAMIC_SEPARATION_OF_DUTIES_NOT_MODELLED`, `LEASE_OWNERSHIP_NOT_PERSISTED_IN_QUARANTINE_STORE`, `NO_RUNTIME_NO_ENDPOINTS`.

## Riesgos residuales

- S7 seguía abierto en runtime al cierre de BE13-10A (ver H2); **se cerró en BE13-10B** (`ADR_BE13_10B_S7_CLOSURE.md`).
- Todo depende de la frontera del bootstrap: código en proceso puede inyectar políticas permisivas (`INJECTED_UNVERIFIED` lo hace visible, no lo impide).
- El `leaseId` es un identificador, no un autenticador; la propiedad se prueba solo con la identidad autenticada.
- El tiempo confiable proviene de una autoridad inyectada no decidida.
- La evaluación de retención no borra nada; tampoco existe proceso de revisión de borrado.
- Sin WORM.

## Estado

| Categoría | Elementos |
| --- | --- |
| IMPLEMENTADO | 9 puertos, bundle, governor de leases, evaluación de retención con legal hold, verificación de evidencia, readiness, placeholders |
| PROBADO | 825/825 offline (49 nuevas); 6/6 mutantes detectados; HTTP 13/13 |
| PENDIENTE (decisión humana) | IdP, mapeo, reglas SoD, expiración de leases, autoridad temporal, retención, legal hold, verificación de evidencia, WORM |
| BLOCKED | EMQX, Atlas, hardware |
| NO VERIFICABLE | Comportamiento con un IdP real |
