-- MainSpot DEC-0078 (SRC-007, TS-1; cierra HUECO-TS-1 / V2-GAP-07) — el tope diario de TypeSafe/Jev (DEC-0032, USD 1 por
-- día UTC, sin cambios) se aplica con reservas ATÓMICAS e idempotentes antes de cada llamada, ya no comprobando y gastando.
-- Migración ADITIVA y transaccional (el runner ejecuta el archivo completo en una transacción). Re-ejecutable.
--
--   1. typesafe_reservation: una fila por llamada a TypeSafe (AI Core, pipeline del chat, evaluación sintética) con su
--      clave de idempotencia, día UTC del presupuesto e importe reservado (costo máximo por llamada de la ruta). Estados:
--        reserved  → reserva en curso: cuenta reserved_usd. Vencida sin enviar deja de contar (se libera); vencida ya
--                    enviada sigue contando reserved_usd;
--        committed → llamada terminada: cuenta el costo medido (informado por el proveedor o estimado con su precio) o,
--                    si se desconoce (error HTTP, tiempo agotado, red o contrato tras enviar), reserved_usd; con
--                    reintentos (attempts > 1) cuenta el mayor de los dos: un error del proveedor no se supone gratis;
--        released  → nunca se envió: no cuenta;
--        expired   → enviada y nunca confirmada (proceso caído a mitad): cuenta reserved_usd hasta que llegue la medición.
--      Sin tenant_id: el tope es global (DEC-0032) y la tabla no guarda datos de negocios ni de personas (no la tocan
--      la retención ni la anonimización).
--   2. Gasto anterior: lo que sumaba el presupuesto previo (cost_usd de jev_classification, de jev_evaluation_run y de
--      ai_invocation de proveedores TypeSafe, por día UTC) queda como UNA fila `legacy` confirmada por día. Solo se
--      calcula con la tabla vacía: volver a ejecutar el archivo nunca cuenta otra vez ese gasto ni el de las llamadas
--      registradas después (que ya tienen su propia fila).
-- Desde aquí el libro es la única fuente del tope; las tablas de origen siguen como evidencia de cada llamada. Aplicar
-- junto con el código que lo usa: el gasto de procesos anteriores entre la migración y el despliegue no entra al libro.
-- No toca filas de otras tablas.
-- Reversión (solo con el código anterior desplegado y mientras no exista ninguna reserva posterior a 0040):
-- scripts/typesafe-reservation-rollback.sql.

CREATE TABLE IF NOT EXISTS typesafe_reservation (
  reservation_id   TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  source           TEXT NOT NULL CHECK (source IN ('ai_core','pipeline','evaluation','legacy')),
  use_case_id      TEXT REFERENCES ai_use_case(use_case_id) ON DELETE RESTRICT,
  budget_day       DATE NOT NULL,                         -- día UTC del presupuesto (DEC-0032)
  reserved_usd     NUMERIC NOT NULL CHECK (reserved_usd >= 0),
  status           TEXT NOT NULL CHECK (status IN ('reserved','committed','released','expired')),
  dispatched_at    TIMESTAMPTZ,                           -- justo antes de la petición HTTP
  attempts         INT CHECK (attempts >= 1),             -- peticiones HTTP de la llamada que terminó bien
  cost_usd         NUMERIC CHECK (cost_usd >= 0),
  cost_source      TEXT CHECK (cost_source IN ('reported','estimated','unknown')),
  reason           TEXT CHECK (length(reason) BETWEEN 1 AND 200),  -- código seguro, nunca texto del proveedor
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at       TIMESTAMPTZ,
  -- Una clave por llamada y su origen: ai_invocation:<id> | pipeline:<request_id> | evaluation:<run>:<caso> | legacy:<día>.
  CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,200}$'
         AND split_part(idempotency_key, ':', 1) = CASE source WHEN 'ai_core' THEN 'ai_invocation' ELSE source END),
  CHECK ((source = 'ai_core') = (use_case_id IS NOT NULL)),
  CHECK ((status = 'reserved') = (settled_at IS NULL)),
  -- Solo se libera lo que nunca salió; todo lo que cuenta un costo salió (salvo el gasto anterior agregado por día).
  CHECK (status <> 'released' OR dispatched_at IS NULL),
  CHECK (source = 'legacy' OR status NOT IN ('committed','expired') OR dispatched_at IS NOT NULL),
  -- Medición: informada o estimada con importe; desconocida sin importe. El gasto anterior no tiene una fuente única.
  CHECK (cost_source IS NULL OR (cost_source = 'unknown') = (cost_usd IS NULL)),
  CHECK (CASE WHEN source = 'legacy' THEN status = 'committed' AND cost_usd IS NOT NULL AND cost_source IS NULL
              ELSE (cost_source IS NOT NULL) = (status IN ('committed','expired')) END)
);
CREATE INDEX IF NOT EXISTS idx_typesafe_reservation_day
  ON typesafe_reservation(budget_day) WHERE status <> 'released';
CREATE INDEX IF NOT EXISTS idx_typesafe_reservation_expiry
  ON typesafe_reservation(expires_at) WHERE status = 'reserved';

-- Gasto anterior, con la misma suma que aplicaba el presupuesto previo (src/conversation/jev-repository.ts, spentOn).
INSERT INTO typesafe_reservation
  (reservation_id, idempotency_key, source, use_case_id, budget_day, reserved_usd, status, cost_usd, cost_source, reason,
   expires_at, settled_at)
SELECT 'tsr_legacy_' || to_char(day, 'YYYYMMDD'), 'legacy:' || to_char(day, 'YYYY-MM-DD'), 'legacy', NULL, day, 0,
       'committed', total, NULL, 'gasto_anterior_0040', now(), now()
  FROM (SELECT day, SUM(cost) AS total
          FROM (SELECT budget_day AS day, cost_usd AS cost FROM jev_classification
                UNION ALL
                SELECT budget_day, cost_usd FROM jev_evaluation_run
                UNION ALL
                SELECT (i.created_at AT TIME ZONE 'UTC')::date, i.cost_usd
                  FROM ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id
                 WHERE p.kind = 'typesafe') spend
         GROUP BY day) legacy
 WHERE total > 0
   AND NOT EXISTS (SELECT 1 FROM typesafe_reservation);
