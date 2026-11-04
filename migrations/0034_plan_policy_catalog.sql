-- MainSpot DEC-0075 (SRC-0013) — catálogo de planes versionado y política efectiva por plan.
-- Migración ADITIVA y transaccional (el runner ejecuta el archivo completo en una transacción):
--   plan_parameter_definition  espejo del registro tipado src/plans/registry.ts (fuente única)
--   plan_revision              revisiones DRAFT → PUBLISHED → SUPERSEDED (o DISCARDED); publicadas inmutables
--   plan_parameter_value       valor explícito por revisión y parámetro, con confirmación individual
--   plan_catalog_event         auditoría detallada append-only (motivo + diff)
--   subscription.plan_revision_id  la suscripción queda FIJADA a su revisión (SRC-0013 revision_policy)
--   subscription_history       historial append-only de toda asignación (también SQL directo)
-- Backfill exacto: cada plan existente recibe la revisión 1 PUBLISHED con los valores de plan_limit (0009);
-- una capacidad sin fila (hoy deny por fail-closed) se explicita como 0 (mismo efecto: deny).
-- plan_limit se conserva intacta como plan_limit_legacy_0009 (solo lectura) para la reversión
-- (scripts/plan-catalog-rollback.sql). Sin precios, cobros ni proveedores de pago (DEC-024).
-- Re-ejecutable: si quedó aplicada pero el runner no llegó a registrarla en schema_migrations, volver a
-- ejecutarla no cambia nada (el backfill solo corre mientras exista plan_limit).

-- ---------------------------------------------------------------- definiciones (espejo del registro)
CREATE TABLE IF NOT EXISTS plan_parameter_definition (
  parameter_key     TEXT PRIMARY KEY CHECK (parameter_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  capability        TEXT UNIQUE CHECK (capability IS NULL OR capability ~ '^[a-z][a-z0-9_]{1,40}$'),
  category          TEXT NOT NULL,
  label             TEXT NOT NULL,
  description       TEXT NOT NULL,
  unit              TEXT NOT NULL,
  value_type        TEXT NOT NULL CHECK (value_type IN ('int','bool')),
  semantics         TEXT NOT NULL CHECK (semantics IN ('cumulative','stock','periodic','rate_window','eligibility')),
  period_kind       TEXT NOT NULL CHECK (period_kind IN ('none','subscription_month','sliding_window')),
  window_seconds    INT CHECK (window_seconds IS NULL OR window_seconds > 0),
  min_value         INT NOT NULL,
  max_value         INT NOT NULL,
  ceiling_reason    TEXT NOT NULL,
  suggested_int     INT,
  suggested_bool    BOOLEAN,
  enforcement_state TEXT NOT NULL CHECK (enforcement_state IN ('enforced','not_enforced')),
  registry_version  INT NOT NULL CHECK (registry_version >= 1),
  sort_order        INT NOT NULL,
  CHECK (min_value <= max_value),
  CHECK ((period_kind = 'sliding_window') = (window_seconds IS NOT NULL)),
  CHECK ((semantics = 'periodic') = (period_kind = 'subscription_month')),
  CHECK ((semantics = 'rate_window') = (period_kind = 'sliding_window')),
  CHECK ((value_type = 'bool') = (semantics = 'eligibility')),
  CHECK (value_type <> 'bool' OR (min_value = 0 AND max_value = 1)),
  CHECK ((value_type = 'int' AND suggested_bool IS NULL AND suggested_int BETWEEN min_value AND max_value)
      OR (value_type = 'bool' AND suggested_int IS NULL AND suggested_bool IS NOT NULL)),
  CHECK (semantics = 'eligibility' OR capability IS NOT NULL)
);

INSERT INTO plan_parameter_definition
  (parameter_key, capability, category, label, description, unit, value_type, semantics, period_kind, window_seconds,
   min_value, max_value, ceiling_reason, suggested_int, suggested_bool, enforcement_state, registry_version, sort_order) VALUES
  ('quota.website.max', 'website', 'Página web', 'Páginas web',
   'Páginas web que el negocio puede crear. Cuenta cada página creada durante toda la suscripción (no se reinicia).',
   'páginas', 'int', 'cumulative', 'none', NULL, 0, 1,
   'Techo técnico 1: client_website.tenant_id es UNIQUE (migración 0005) y el código asume una sola página por negocio; multi-sitio exige cambio de esquema.',
   1, NULL, 'enforced', 1, 10),
  ('quota.social_posts.max', 'social_posts', 'Redes sociales', 'Publicaciones en redes',
   'Borradores de publicación que el negocio puede crear (cualquier estado). Cuenta durante toda la suscripción; no se reinicia ni se libera al rechazar o fallar.',
   'publicaciones', 'int', 'cumulative', 'none', NULL, 0, 1000000,
   'Límite de validación de plataforma (1,000,000) contra errores de captura; no existe «ilimitado» (fail-closed).',
   10, NULL, 'enforced', 1, 20),
  ('quota.social_ads.max', 'social_ads', 'Redes sociales', 'Anuncios en redes',
   'Borradores de anuncio que el negocio puede crear. Cuenta durante toda la suscripción. 0 = sin anuncios. La entrega real de anuncios no está disponible (sin gasto).',
   'anuncios', 'int', 'cumulative', 'none', NULL, 0, 1000000,
   'Límite de validación de plataforma (1,000,000) contra errores de captura; no existe «ilimitado» (fail-closed).',
   5, NULL, 'enforced', 1, 30),
  ('quota.reviews_managed.max', 'reviews_managed', 'Reseñas', 'Reseñas gestionadas',
   'Reseñas que MainSpot puede ingerir y gestionar. Cuenta todas las reseñas ingeridas durante toda la suscripción; cada sincronización consume el lote completo o nada.',
   'reseñas', 'int', 'cumulative', 'none', NULL, 0, 1000000,
   'Límite de validación de plataforma (1,000,000) contra errores de captura; no existe «ilimitado» (fail-closed).',
   20, NULL, 'enforced', 1, 40),
  ('quota.conversations.max', 'conversations', 'Asistente', 'Solicitudes al asistente',
   'Solicitudes registradas del negocio (mensajes al asistente y solicitudes internas). Cuenta durante toda la suscripción. 0 = el negocio no puede enviar mensajes al asistente.',
   'solicitudes', 'int', 'cumulative', 'none', NULL, 0, 1000000,
   'Límite de validación de plataforma (1,000,000) contra errores de captura; no existe «ilimitado» (fail-closed).',
   500, NULL, 'enforced', 1, 50),
  ('quota.agents.max', 'agents', 'Equipo', 'Usuarios del panel',
   'Usuarios internos del panel del negocio. Hoy NO se aplica: dar de alta usuarios no consume esta cuota (DEC-0006/DEC-0017 difieren el enforcement).',
   'usuarios', 'int', 'cumulative', 'none', NULL, 0, 1000000,
   'Límite de validación de plataforma (1,000,000) contra errores de captura; no existe «ilimitado» (fail-closed).',
   5, NULL, 'not_enforced', 1, 60)
ON CONFLICT (parameter_key) DO NOTHING;

-- El libro de cuotas acepta capacidades del registro (antes: CHECK con la lista fija de 0014).
ALTER TABLE quota_reservation DROP CONSTRAINT IF EXISTS quota_reservation_capability_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quota_reservation_capability_fk') THEN
    ALTER TABLE quota_reservation ADD CONSTRAINT quota_reservation_capability_fk
      FOREIGN KEY (capability) REFERENCES plan_parameter_definition(capability) ON DELETE RESTRICT;
  END IF;
END $$;
-- Uso periódico / por ventana: unidades confirmadas por (tenant, capacidad) y fecha de liquidación.
CREATE INDEX IF NOT EXISTS idx_quota_reservation_committed
  ON quota_reservation(tenant_id, capability, settled_at) WHERE state = 'committed';

-- ---------------------------------------------------------------- plan (identidad comercial, sin precio)
ALTER TABLE plan ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'system:seed-0009';
ALTER TABLE plan ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- Nombres únicos sin distinguir mayúsculas (la consola compara así; dos altas concurrentes ⇒ 409, no 500).
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_name_lower ON plan (lower(name));

-- ---------------------------------------------------------------- revisiones
CREATE TABLE IF NOT EXISTS plan_revision (
  revision_id          TEXT PRIMARY KEY,
  plan_id              TEXT NOT NULL REFERENCES plan(plan_id) ON DELETE RESTRICT,
  version              INT  NOT NULL CHECK (version >= 1),
  status               TEXT NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED','DISCARDED')),
  origin               TEXT NOT NULL CHECK (origin IN ('backfill','create','clone','edit','rollback')),
  based_on_revision_id TEXT REFERENCES plan_revision(revision_id) ON DELETE RESTRICT,
  lock_version         INT  NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
  registry_version     INT  NOT NULL CHECK (registry_version >= 1),
  reason               TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  created_by           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by         TEXT,
  published_at         TIMESTAMPTZ,
  publish_reason       TEXT CHECK (publish_reason IS NULL OR length(publish_reason) BETWEEN 10 AND 500),
  checksum             TEXT CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'),
  superseded_at        TIMESTAMPTZ,
  discarded_at         TIMESTAMPTZ,
  UNIQUE (plan_id, version),
  UNIQUE (plan_id, revision_id),
  CHECK ((status IN ('PUBLISHED','SUPERSEDED'))
         = (published_at IS NOT NULL AND published_by IS NOT NULL AND publish_reason IS NOT NULL AND checksum IS NOT NULL)),
  CHECK ((status = 'SUPERSEDED') = (superseded_at IS NOT NULL)),
  CHECK ((status = 'DISCARDED') = (discarded_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_revision_one_draft ON plan_revision(plan_id) WHERE status = 'DRAFT';
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_revision_one_published ON plan_revision(plan_id) WHERE status = 'PUBLISHED';

CREATE TABLE IF NOT EXISTS plan_parameter_value (
  revision_id   TEXT NOT NULL REFERENCES plan_revision(revision_id) ON DELETE RESTRICT,
  parameter_key TEXT NOT NULL REFERENCES plan_parameter_definition(parameter_key) ON DELETE RESTRICT,
  value_int     INT,
  value_bool    BOOLEAN,
  source        TEXT NOT NULL CHECK (source IN ('suggested','copied','explicit','backfill','backfill_absent_deny','rollback')),
  confirmed_by  TEXT,
  confirmed_at  TIMESTAMPTZ,
  updated_by    TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (revision_id, parameter_key),
  CHECK (value_int IS NULL OR value_bool IS NULL),
  CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
  CHECK (confirmed_at IS NULL OR value_int IS NOT NULL OR value_bool IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS plan_catalog_event (
  event_id    TEXT PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    TEXT NOT NULL,
  actor_roles TEXT[] NOT NULL DEFAULT '{}',
  action      TEXT NOT NULL,
  plan_id     TEXT REFERENCES plan(plan_id) ON DELETE RESTRICT,
  revision_id TEXT REFERENCES plan_revision(revision_id) ON DELETE RESTRICT,
  reason      TEXT,
  diff        JSONB NOT NULL DEFAULT '[]'::jsonb,
  request_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_catalog_event_plan ON plan_catalog_event(plan_id, at DESC);
DROP TRIGGER IF EXISTS trg_plan_catalog_event_immutable ON plan_catalog_event;
CREATE TRIGGER trg_plan_catalog_event_immutable BEFORE UPDATE OR DELETE ON plan_catalog_event
  FOR EACH ROW EXECUTE FUNCTION ai_forbid_mutation();
-- TRUNCATE no dispara los triggers de fila: cada tabla append-only o inmutable de 0034 lo prohíbe aparte.
DROP TRIGGER IF EXISTS trg_plan_catalog_event_no_truncate ON plan_catalog_event;
CREATE TRIGGER trg_plan_catalog_event_no_truncate BEFORE TRUNCATE ON plan_catalog_event
  FOR EACH STATEMENT EXECUTE FUNCTION ai_forbid_mutation();

-- Huella canónica de los valores de una revisión: `clave=valor` por línea, ordenado por clave (C),
-- sha256 hex. src/plans/catalog.ts calcula la misma forma.
CREATE OR REPLACE FUNCTION plan_revision_checksum(p_revision TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT encode(digest(COALESCE(string_agg(v.parameter_key || '=' || COALESCE(v.value_int::text, v.value_bool::text),
                                           E'\n' ORDER BY v.parameter_key COLLATE "C"), ''), 'sha256'), 'hex')
    FROM plan_parameter_value v WHERE v.revision_id = p_revision
$$;

-- Revisión: nace DRAFT; solo DRAFT es editable; publicar exige TODOS los parámetros del registro con valor
-- confirmado y huella correcta; una publicada solo puede pasar a SUPERSEDED; nada se borra.
CREATE OR REPLACE FUNCTION plan_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  missing INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plan_revision % cannot be deleted (discard it instead)', OLD.revision_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'plan_revision must be created as DRAFT' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revision_id <> OLD.revision_id OR NEW.plan_id <> OLD.plan_id OR NEW.version <> OLD.version
     OR NEW.origin <> OLD.origin OR NEW.based_on_revision_id IS DISTINCT FROM OLD.based_on_revision_id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR NEW.registry_version <> OLD.registry_version THEN
    RAISE EXCEPTION 'plan_revision identity columns are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status = 'PUBLISHED' THEN
      -- FOR SHARE de sus valores antes de validarlos: en REPEATABLE READ o SERIALIZABLE la validación usaría la
      -- instantánea de la transacción y un valor cambiado después termina aquí en 40001 en vez de publicarse con
      -- valores viejos. En READ COMMITTED no cambia el resultado: lo de abajo ya ve lo confirmado.
      -- Interbloqueo posible (40P01): si una escritura SQL de un valor llega cuando la publicación ya bloqueó la
      -- revisión (la app la toma FOR UPDATE antes de publicar), la escritura espera a la revisión y la publicación
      -- a esa fila de valor. Tras deadlock_timeout PostgreSQL aborta una de las dos y la otra termina; nunca queda
      -- una revisión publicada con valores sin confirmar ni con otra huella. Las escrituras de la app no llegan a
      -- esto: toman antes plan FOR UPDATE.
      PERFORM 1 FROM plan_parameter_value WHERE revision_id = NEW.revision_id FOR SHARE;
      SELECT count(*) INTO missing FROM plan_parameter_definition d
        LEFT JOIN plan_parameter_value v ON v.revision_id = NEW.revision_id AND v.parameter_key = d.parameter_key
       WHERE v.parameter_key IS NULL OR v.confirmed_at IS NULL OR (v.value_int IS NULL AND v.value_bool IS NULL);
      IF missing > 0 THEN
        RAISE EXCEPTION 'plan_revision %: % parameter(s) without a confirmed value', NEW.revision_id, missing USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.checksum IS DISTINCT FROM plan_revision_checksum(NEW.revision_id) THEN
        RAISE EXCEPTION 'plan_revision %: checksum does not match its values', NEW.revision_id USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.status NOT IN ('DRAFT','DISCARDED') THEN
      RAISE EXCEPTION 'plan_revision: DRAFT can only become PUBLISHED or DISCARDED' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED'
     AND NEW.lock_version = OLD.lock_version AND NEW.reason = OLD.reason AND NEW.updated_at = OLD.updated_at
     AND NEW.published_by = OLD.published_by AND NEW.published_at = OLD.published_at
     AND NEW.publish_reason = OLD.publish_reason AND NEW.checksum = OLD.checksum AND NEW.discarded_at IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'plan_revision % (%) is immutable', OLD.revision_id, OLD.status USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS trg_plan_revision_guard ON plan_revision;
CREATE TRIGGER trg_plan_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON plan_revision
  FOR EACH ROW EXECUTE FUNCTION plan_revision_guard();
DROP TRIGGER IF EXISTS trg_plan_revision_no_truncate ON plan_revision;
CREATE TRIGGER trg_plan_revision_no_truncate BEFORE TRUNCATE ON plan_revision
  FOR EACH STATEMENT EXECUTE FUNCTION ai_forbid_mutation();

-- Valores: solo en revisiones DRAFT; tipo y rango contra la definición; cambiar un valor borra su
-- confirmación salvo que la misma escritura confirme de nuevo; nunca se borran.
CREATE OR REPLACE FUNCTION plan_parameter_value_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rev_status TEXT;
  def plan_parameter_definition%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plan_parameter_value cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.revision_id <> OLD.revision_id OR NEW.parameter_key <> OLD.parameter_key) THEN
    RAISE EXCEPTION 'plan_parameter_value keys are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- FOR SHARE: serializa con la publicación, que actualiza esta fila (READ COMMITTED). Si la publicación va
  -- primero, esta escritura la espera y ve la revisión ya publicada; si va después, la publicación espera a
  -- que esta escritura termine y su comprobación (valores confirmados y huella) ve el valor nuevo.
  SELECT status INTO rev_status FROM plan_revision WHERE revision_id = NEW.revision_id FOR SHARE;
  IF rev_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'plan_parameter_value: revision % is % and immutable', NEW.revision_id, COALESCE(rev_status, 'missing') USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO def FROM plan_parameter_definition WHERE parameter_key = NEW.parameter_key;
  IF def.value_type = 'int' THEN
    IF NEW.value_bool IS NOT NULL OR (NEW.value_int IS NOT NULL AND NEW.value_int NOT BETWEEN def.min_value AND def.max_value) THEN
      RAISE EXCEPTION 'plan_parameter_value %: integer outside [%, %]', NEW.parameter_key, def.min_value, def.max_value USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.value_int IS NOT NULL THEN
    RAISE EXCEPTION 'plan_parameter_value %: boolean expected', NEW.parameter_key USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.value_int IS DISTINCT FROM OLD.value_int OR NEW.value_bool IS DISTINCT FROM OLD.value_bool)
     AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at THEN
    NEW.confirmed_at := NULL;
    NEW.confirmed_by := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_plan_parameter_value_guard ON plan_parameter_value;
CREATE TRIGGER trg_plan_parameter_value_guard BEFORE INSERT OR UPDATE OR DELETE ON plan_parameter_value
  FOR EACH ROW EXECUTE FUNCTION plan_parameter_value_guard();
DROP TRIGGER IF EXISTS trg_plan_parameter_value_no_truncate ON plan_parameter_value;
CREATE TRIGGER trg_plan_parameter_value_no_truncate BEFORE TRUNCATE ON plan_parameter_value
  FOR EACH STATEMENT EXECUTE FUNCTION ai_forbid_mutation();

-- ---------------------------------------------------------------- suscripción fijada a su revisión
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS plan_revision_id TEXT;

CREATE TABLE IF NOT EXISTS subscription_history (
  history_id           TEXT PRIMARY KEY DEFAULT ('sh_' || gen_random_uuid()::text),
  subscription_id      TEXT NOT NULL,
  tenant_id            TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
  change_kind          TEXT NOT NULL CHECK (change_kind IN ('backfill','assign','plan_change','revision_migration','status_change')),
  plan_id              TEXT NOT NULL,
  plan_revision_id     TEXT NOT NULL,
  status               TEXT NOT NULL,
  previous_plan_id     TEXT,
  previous_revision_id TEXT,
  previous_status      TEXT,
  actor                TEXT NOT NULL,
  reason               TEXT,
  request_id           TEXT,
  changed_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_subscription_history_tenant ON subscription_history(tenant_id, changed_at DESC);

-- Append-only; la única excepción es el borrado dentro de la anonimización de ESE negocio (DEC-0027).
CREATE OR REPLACE FUNCTION subscription_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('mainspot.anonymizing_tenant', true) = OLD.tenant_id THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS trg_subscription_history_guard ON subscription_history;
CREATE TRIGGER trg_subscription_history_guard BEFORE UPDATE OR DELETE ON subscription_history
  FOR EACH ROW EXECUTE FUNCTION subscription_history_guard();
-- TRUNCATE no tiene excepción: la anonimización borra las filas de su negocio con DELETE.
DROP TRIGGER IF EXISTS trg_subscription_history_no_truncate ON subscription_history;
CREATE TRIGGER trg_subscription_history_no_truncate BEFORE TRUNCATE ON subscription_history
  FOR EACH STATEMENT EXECUTE FUNCTION ai_forbid_mutation();

-- Asignación: un plan solo se asigna si está habilitado y con revisión publicada; sin revisión explícita
-- se fija la publicada vigente; una revisión explícita debe ser la PUBLISHED del mismo plan. Los cambios
-- solo de estado (suspender, cancelar) no tocan la revisión.
CREATE OR REPLACE FUNCTION subscription_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  published TEXT;
  plan_enabled BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.plan_id = OLD.plan_id AND NEW.plan_revision_id IS NOT DISTINCT FROM OLD.plan_revision_id THEN
    RETURN NEW;
  END IF;
  -- FOR SHARE en su propia sentencia: una publicación del plan (que toma plan FOR UPDATE) termina antes y la
  -- revisión publicada se lee DESPUÉS con instantánea nueva (READ COMMITTED): se fija la que quedó publicada.
  SELECT active INTO plan_enabled FROM plan WHERE plan_id = NEW.plan_id FOR SHARE;
  SELECT revision_id INTO published FROM plan_revision WHERE plan_id = NEW.plan_id AND status = 'PUBLISHED';
  IF TG_OP = 'INSERT' OR NEW.plan_id <> OLD.plan_id THEN
    IF plan_enabled IS DISTINCT FROM true OR published IS NULL THEN
      RAISE EXCEPTION 'plan % is not assignable (disabled or without a published revision)', NEW.plan_id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.plan_revision_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.plan_revision_id IS NOT DISTINCT FROM OLD.plan_revision_id) THEN
      NEW.plan_revision_id := published;
    END IF;
  END IF;
  IF NEW.plan_revision_id IS DISTINCT FROM published THEN
    RAISE EXCEPTION 'subscription can only be pinned to the published revision of plan %', NEW.plan_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION subscription_history_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kind TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.plan_id = OLD.plan_id AND NEW.plan_revision_id IS NOT DISTINCT FROM OLD.plan_revision_id
     AND NEW.status = OLD.status THEN
    RETURN NULL;
  END IF;
  kind := NULLIF(current_setting('mainspot.subscription_change', true), '');
  IF kind IS NULL THEN
    kind := CASE
      WHEN TG_OP = 'INSERT' THEN 'assign'
      WHEN NEW.plan_id <> OLD.plan_id THEN 'plan_change'
      WHEN NEW.plan_revision_id IS DISTINCT FROM OLD.plan_revision_id THEN 'revision_migration'
      ELSE 'status_change' END;
  END IF;
  INSERT INTO subscription_history (subscription_id, tenant_id, change_kind, plan_id, plan_revision_id, status,
                                    previous_plan_id, previous_revision_id, previous_status, actor, reason, request_id)
  VALUES (NEW.subscription_id, NEW.tenant_id, kind, NEW.plan_id, NEW.plan_revision_id, NEW.status,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.plan_id END, CASE WHEN TG_OP = 'UPDATE' THEN OLD.plan_revision_id END,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
          COALESCE(NULLIF(current_setting('mainspot.actor', true), ''), 'sql:' || session_user),
          NULLIF(current_setting('mainspot.reason', true), ''), NULLIF(current_setting('mainspot.request_id', true), ''));
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------- backfill exacto (sin pérdida)
-- Solo desde la forma 0009 (existe plan_limit). Si 0034 ya se aplicó pero no quedó registrada (caída del
-- runner entre el archivo y su INSERT en schema_migrations), plan_limit ya es plan_limit_legacy_0009 y la
-- re-ejecución no crea, cambia ni publica revisiones ni valores. EXECUTE: el SQL que nombra plan_limit solo
-- se analiza cuando la tabla existe.
DO $$
DECLARE
  unknown_capability BOOLEAN;
BEGIN
  IF to_regclass('public.plan_limit') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM plan_limit l
                           WHERE NOT EXISTS (SELECT 1 FROM plan_parameter_definition d WHERE d.capability = l.capability))'
     INTO unknown_capability;
  IF unknown_capability THEN
    RAISE EXCEPTION 'plan_limit has capabilities outside the plan parameter registry: migration 0034 aborted to avoid losing values';
  END IF;

  INSERT INTO plan_revision (revision_id, plan_id, version, status, origin, registry_version, reason, created_by)
  SELECT 'prv_' || p.plan_id || '_v1', p.plan_id, 1, 'DRAFT', 'backfill', 1,
         'Backfill 0034: valores vigentes de plan_limit (0009) explicitados sin cambios.', 'system:migration-0034'
    FROM plan p
   WHERE NOT EXISTS (SELECT 1 FROM plan_revision r WHERE r.plan_id = p.plan_id);

  EXECUTE $backfill$
    INSERT INTO plan_parameter_value (revision_id, parameter_key, value_int, source, confirmed_by, confirmed_at, updated_by)
    SELECT r.revision_id, d.parameter_key, COALESCE(l.max_value, 0),
           CASE WHEN l.limit_id IS NULL THEN 'backfill_absent_deny' ELSE 'backfill' END,
           'system:migration-0034', now(), 'system:migration-0034'
      FROM plan_revision r
      JOIN plan_parameter_definition d ON true
      LEFT JOIN plan_limit l ON l.plan_id = r.plan_id AND l.capability = d.capability
     WHERE r.origin = 'backfill' AND r.status = 'DRAFT'
    ON CONFLICT (revision_id, parameter_key) DO NOTHING
  $backfill$;

  UPDATE plan_revision
     SET status = 'PUBLISHED', published_by = 'system:migration-0034', published_at = now(),
         publish_reason = reason, checksum = plan_revision_checksum(revision_id)
   WHERE origin = 'backfill' AND status = 'DRAFT';
END $$;

-- Suscripciones vigentes: fijadas a la revisión 1 de su plan (sus límites no cambian), con historial.
DROP TRIGGER IF EXISTS trg_subscription_history ON subscription;
CREATE TRIGGER trg_subscription_history AFTER INSERT OR UPDATE ON subscription
  FOR EACH ROW EXECUTE FUNCTION subscription_history_record();
SELECT set_config('mainspot.actor', 'system:migration-0034', true),
       set_config('mainspot.subscription_change', 'backfill', true),
       set_config('mainspot.reason', 'Backfill 0034: suscripción fijada a la revisión 1 de su plan (valores vigentes).', true);
UPDATE subscription s SET plan_revision_id = r.revision_id
  FROM plan_revision r
 WHERE r.plan_id = s.plan_id AND r.status = 'PUBLISHED' AND s.plan_revision_id IS NULL;
SELECT set_config('mainspot.actor', '', true), set_config('mainspot.subscription_change', '', true), set_config('mainspot.reason', '', true);

ALTER TABLE subscription ALTER COLUMN plan_revision_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscription_plan_revision_fk') THEN
    ALTER TABLE subscription ADD CONSTRAINT subscription_plan_revision_fk
      FOREIGN KEY (plan_id, plan_revision_id) REFERENCES plan_revision(plan_id, revision_id) ON DELETE RESTRICT;
  END IF;
END $$;
DROP TRIGGER IF EXISTS trg_subscription_assignment_guard ON subscription;
CREATE TRIGGER trg_subscription_assignment_guard BEFORE INSERT OR UPDATE ON subscription
  FOR EACH ROW EXECUTE FUNCTION subscription_assignment_guard();

-- Un plan habilitado siempre tiene una revisión publicada (comprobado al confirmar la transacción).
CREATE OR REPLACE FUNCTION plan_enabled_requires_published() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pid TEXT := NEW.plan_id;  -- plan y plan_revision comparten la columna plan_id
BEGIN
  IF EXISTS (SELECT 1 FROM plan p WHERE p.plan_id = pid AND p.active)
     AND NOT EXISTS (SELECT 1 FROM plan_revision r WHERE r.plan_id = pid AND r.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'plan % is enabled without a published revision', pid USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_plan_enabled_published ON plan;
CREATE CONSTRAINT TRIGGER trg_plan_enabled_published AFTER INSERT OR UPDATE ON plan
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION plan_enabled_requires_published();
DROP TRIGGER IF EXISTS trg_plan_revision_enabled_published ON plan_revision;
CREATE CONSTRAINT TRIGGER trg_plan_revision_enabled_published AFTER UPDATE ON plan_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION plan_enabled_requires_published();

-- ---------------------------------------------------------------- plan_limit: legado de solo lectura
DO $$ BEGIN
  IF to_regclass('public.plan_limit') IS NOT NULL AND to_regclass('public.plan_limit_legacy_0009') IS NULL THEN
    ALTER TABLE plan_limit RENAME TO plan_limit_legacy_0009;
  END IF;
END $$;
DROP TRIGGER IF EXISTS trg_plan_limit_legacy_readonly ON plan_limit_legacy_0009;
CREATE TRIGGER trg_plan_limit_legacy_readonly BEFORE INSERT OR UPDATE OR DELETE ON plan_limit_legacy_0009
  FOR EACH ROW EXECUTE FUNCTION ai_forbid_mutation();
DROP TRIGGER IF EXISTS trg_plan_limit_legacy_no_truncate ON plan_limit_legacy_0009;
CREATE TRIGGER trg_plan_limit_legacy_no_truncate BEFORE TRUNCATE ON plan_limit_legacy_0009
  FOR EACH STATEMENT EXECUTE FUNCTION ai_forbid_mutation();

-- ---------------------------------------------------------------- permisos del negocio
-- SRC-0013 self_assign: el negocio ya no asigna planes (la ruta responde 403). `subscription.admin`
-- se conserva solo para la facturación, que sigue PROHIBITED sin precio (DEC-024).
UPDATE permission SET description = 'Gestionar la facturación del cliente (prohibida sin precio aprobado; la asignación de planes es de MainSpot Administration)'
 WHERE permission_id = 'subscription.admin';
UPDATE permission SET description = 'Ver el plan, los límites y el consumo del cliente' WHERE permission_id = 'subscription.read';
