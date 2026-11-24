# BE13-11B — Contrato de recuperación

```ts
admission.processPersistedBrokerDelivery({ inboxId }) → 'ingested' | 'rejected'
admission.admitForReplay({ inboxId })                 → 'admitted' | 'rejected'   // evidencia para un replay operado
```

El realm es siempre el del bootstrap. **No se acepta un payload nuevo:** cualquier otro campo de la entrada se ignora (D12).

## Pasos (`loadVerifiedRecord`, compartido por los dos métodos)

1. `inboxId` con forma válida; si no, `broker-inbox-not-found`.
2. Audit `inbox-recovery-started` (best-effort).
3. `getById({ realm, inboxId })` con `readConcern: majority` y filtro `{ _id, realm }`.
   - excepción o timeout → `broker-inbox-unavailable` (transitorio, alerta `BROKER_INBOX_RECOVERY_FAILURE`);
   - `null` → `broker-inbox-not-found`.
4. Esquema estricto del registro: si es malformado o tiene un getter hostil → `broker-inbox-integrity-failed`.
5. **Integridad recomputada:**
   - el realm y el id coinciden;
   - `sha256(bytes) == rawPayloadSha256`;
   - la cantidad de bytes coincide;
   - el `contextFingerprint` recomputado coincide;
   - el `provenanceFingerprint` recomputado coincide.
   
   Cualquier diferencia → `broker-inbox-integrity-failed` (clase `consistency`, no reintentable), con alerta `BROKER_INBOX_INTEGRITY_FAILURE`, audit `inbox-integrity-failed` y métrica. **No se repara.**
6. Los bytes almacenados se vuelven a parsear con los límites vigentes. Se rechaza si el retained está bloqueado, si la ruta del topic ya no existe, si la clave técnica no coincide (la del registro y los claims del payload) o si no queda ningún campo configurado.
7. Se arma el documento protegido con `persistedAt = rawPersistedAt` del registro. Recién entonces corre el pipeline BE13-02…10B. Se registra el audit `inbox-processed` y la métrica `broker_inbox_recovery_total{processed}`.

## Garantías

- **Crash entre persistencia y pipeline:** el registro majority sigue disponible. Un proceso nuevo lo procesa (D11, I11), incluso después de un failover del primario (I27).
- **Falla del pipeline después de persistir:** el registro queda intacto y recuperable (D19, I19).
- **Recuperación repetida o concurrente:** la idempotencia de BE13-06 asegura como máximo una medición (D20, I20/I21). El costo es procesar duplicado (verificar y llegar a `duplicate`). No se implementó un lease de inbox porque no hizo falta.
- **Otro realm:** conocer un `inboxId` no permite procesarlo desde otro realm (D08, A03, I16).
- **Revocación:** no se revalida la procedencia contra una autoridad externa. Una entrega verificada y persistida sigue siendo procesable aunque después se revoque la identidad (decisión pendiente).
- **Sin worker:** nadie busca registros pendientes. Los huérfanos (escritura no confirmada que después aparece) requieren una reconciliación futura (N4).
