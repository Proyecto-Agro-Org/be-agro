# MATRIZ BE13-11D — Vectores adversariales

| ID | Vector | Defensa | Evidencia |
|---|---|---|---|
| A01 | Credential stuffing | El broker rechaza (autenticador) antes del boundary; credenciales con forma de real ni crean cliente | E02 (7 intentos), A01 offline |
| A02 | Spoof de clientId | El client id es un hecho observado; la identidad sale del mapping del principal | E05, A02 |
| A03 | Spoof de topic | ACL del broker (135) y el topic solo enruta; el realm no cambia | E06, A03 |
| A04 | `sourceId` en el payload | Envelope cerrado + `sourceId` del mapping | E07, A04/A05 |
| A05 | `realm` en el payload | Envelope cerrado + realm del bootstrap | E08, A04/A05 |
| A06 | Retained | Bloqueado por defecto | E14, A06 |
| A07 | UTF-8 inválido | Parser (antes del verifier/inbox) | E15b, A06–A09 |
| A08 | Claves peligrosas anidadas | Parser | E16, E15b, A06–A09 |
| A09 | Payload enorme | Límite antes del verifier | E17, A06–A09 |
| A10 | Identidad stale tras reconexión/reinicio | Nueva `connectionReference`; principal de la autenticación vigente | E23, E24, A10/A11 |
| A11 | Reutilización de identidad de sesión | Credenciales de B + client id de A rechazados | E37, A10/A11 |
| A12 | Reutilización de `packetId` | Nunca es identidad; ids de inbox aleatorios | A12/A13, 11C A15 |
| A13 | `eventId` duplicado | Idempotencia de negocio | E11, A12/A13 |
| A14 | Crash del consumer (3 puntos) | Redelivery o recuperación por inbox/política | E18, E19, E20, E21/E22 |
| A15 | Reinicio del broker | Consumer nuevo; atacante sigue rechazado | E24 |
| A16 | Mongo no disponible / sin majority | Sin ACK; reentrega; reconciliación de huérfanos | E13, E25, E33, E34 |
| A17 | `rawPersistedAt` falso | Esquema cerrado; solo `$$NOW` de Mongo | A17/A18, E04 |
| A18 | Flag de autenticación/trusted falso | Esquema cerrado del envelope y del boundary | A17/A18, A19 |
| A19 | Publicar en el topic "verificado" para falsificar el envelope | ACL: 135 | E06 |
| A20 | Principal desconocido con el client id de A | Mapping (no hay principal) | E03/E26/E27, mutante M3 |
| A21 | Reclamar `receipted` de otro realm | Realm en rawExists, filtro y scan | E21c, mutante M7 |
| A22 | Configuración del lab apuntando a un broker externo | Guard loopback | D01, D02 |
| A23 | Credencial en logs / registros / audit | Credenciales generadas y scrub; revisión de logs | E35, E36 |
