# INFORME BE13-11G — Auditoría

- Código: un cambio en `src/repositories/mongo-measurement-persistence.repository.ts` (`readClaim`: `readConcern: majority` sólo sin sesión). El resto son scripts de laboratorio y tests.
- Seguridad: sin credenciales nuevas; laboratorio Docker local desechable; sin Atlas ni broker externo. Contenedores y volúmenes del laboratorio en 0 tras la corrida final.
- Riesgo del fix: la lectura majority puede esperar o fallar sin majority. El pre-check está acotado (`maxTimeMS: 3000`) y un fallo no se traduce en `duplicate` (G01: `absent`, nunca `present`).
- Alcance respetado: ≤3 sondeos, una corrida final, sin mutantes, F-E2 no reabierto.
- Pendiente: no hay corrida previa al fix con la matriz por evento.
