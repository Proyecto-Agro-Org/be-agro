# BE13-10A — Contrato de verificación de evidencia

## Puerto

```ts
interface ResolutionEvidenceVerifier {
  verify({ realm, quarantineId, evidence: { evidenceType, reference, verification: 'DECLARED_UNVERIFIED' } }):
    Promise<{ realm; reference; status: 'VERIFIED' | 'UNVERIFIED' | 'REJECTED'; verifierRevision }>;
}
```

## Reglas (`bundle.verifyEvidence({ quarantineId, evidence })`)

1. La entrada solo admite evidencia **declarada** (`verification: 'DECLARED_UNVERIFIED'`), esquema estricto. Un llamador que declare `VERIFIED`, agregue `signature`/`status` o use un tipo desconocido → `REJECTED` / `invalid-request` (X7).
2. `VERIFIED` solo puede venir del verificador inyectado, para **el mismo realm y la misma referencia** (E02, X7).
3. Respuesta malformada, de otro realm, de otra referencia, excepción o timeout → `UNVERIFIED` / `verifier-unavailable` (E04, E05). Nunca `VERIFIED`.
4. Default: placeholder → `UNVERIFIED` (E01).

## Sin criptografía inventada

No hay firmas caseras, hashes como autenticación, MACs sin gestión de claves ni PKI. Si en el futuro la verificación usa firmas, el verificador aprobado será responsable de ellas y de su gestión de claves.

## No conectado a BE13-09

`resolve` de BE13-09 sigue aceptando evidencia `DECLARED_UNVERIFIED` con la medición confirmada por recovery. Exigir `VERIFIED` cambiaría la semántica: es una decisión humana pendiente.
