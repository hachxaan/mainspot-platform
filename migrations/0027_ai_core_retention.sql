-- AI Core × retención (DEC-0024/DEC-0027): la anonimización de un negocio debe poder re-etiquetar
-- las filas de la auditoría de plataforma que lo nombran, igual que hace con audit_event.
-- La tabla sigue siendo append-only para todo lo demás: la ÚNICA excepción es un UPDATE dentro
-- de la transacción que anonimiza ESE negocio (variable local `mainspot.anonymizing_tenant`), que
-- solo puede cambiar el negocio, el recurso, el motivo y el request_id. Quién, qué, cuándo y la
-- decisión se conservan intactos.

CREATE OR REPLACE FUNCTION platform_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.tenant_id IS NOT NULL
     AND current_setting('mainspot.anonymizing_tenant', true) = OLD.tenant_id
     AND NEW.event_id = OLD.event_id AND NEW.at = OLD.at AND NEW.actor_id = OLD.actor_id
     AND NEW.actor_roles = OLD.actor_roles AND NEW.action = OLD.action AND NEW.decision = OLD.decision
     AND NEW.result IS NOT DISTINCT FROM OLD.result THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS trg_platform_audit_immutable ON platform_audit_event;
CREATE TRIGGER trg_platform_audit_immutable BEFORE UPDATE OR DELETE ON platform_audit_event
  FOR EACH ROW EXECUTE FUNCTION platform_audit_guard();
