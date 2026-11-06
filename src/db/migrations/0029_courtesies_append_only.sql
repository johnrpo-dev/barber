-- Sprint 8, auditoría de seguridad (B1): appointment_courtesies es solo-inserción también en la base.
-- Hasta aquí lo garantizaban solo los permisos (villa_app tiene SELECT e INSERT, sin UPDATE ni DELETE:
-- 0026). Como en recurring_expense_runs (0028), client_consents y notifications (0007), triggers que
-- rechazan UPDATE, DELETE y TRUNCATE a cualquier rol, incluido el dueño del esquema: una cortesía dada
-- no se cambia ni se borra. Sin cambios de esquema ni de app_apply_grants.
CREATE TRIGGER appointment_courtesies_no_mutation BEFORE UPDATE OR DELETE ON appointment_courtesies
  FOR EACH ROW EXECUTE FUNCTION public_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER appointment_courtesies_no_truncate BEFORE TRUNCATE ON appointment_courtesies
  FOR EACH STATEMENT EXECUTE FUNCTION public_forbid_mutation();
