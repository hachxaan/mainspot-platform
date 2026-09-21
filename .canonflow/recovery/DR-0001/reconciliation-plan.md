# DR-0001 — Plan de reconciliación (canonización inversa mainspot-platform)

Ejecutado por el agente; NINGUNA decisión tomada sin el humano.

1. Inventario S1/S3/S6/S7 completo (ver drift-report.yaml). Cero escrituras a código.
2. Canon fijado: FC/TC v0.1.0 (pinned desde la baseline aprobada upstream, DEC-015).
   - DECIDED: capacidades y reglas de la baseline (FR/BR + stack/patrones TC).
   - INFERRED: comportamiento recuperado no fijado por canon (NFR-0001..0005, API-0004).
3. Divergencias clasificadas DI-0001..0005 (ver reporte).
4. DECISIONES PENDIENTES DEL HUMANO — Human Decision Console:
   - QS-0001: cierre técnico de las decisiones TENTATIVA (http://127.0.0.1:8765/ → Decisions)
   - QS-0002: oferta comercial (Q-004) y vertical del piloto (Q-009) (http://127.0.0.1:8765/ → Decisions)
5. Tras las decisiones: staging patches (R1), remediaciones (R2..R4) o RSK con expiry (R5).
