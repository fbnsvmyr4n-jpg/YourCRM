import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The audit entries a tenant transaction has produced so far.
 *
 * `logWrite` is called from all over the application with no database handle,
 * so it cannot insert anything itself. It records the entry here instead, and
 * `withTenant` writes what was collected just before it commits — in the same
 * transaction as the change, so the two stand or fall together.
 *
 * A module of its own, importing nothing, so the logger and the transaction
 * code can both use it without importing each other.
 */
export type AuditEntry = {
  action: string;
  entity: string;
  entityId: string | null;
  actor: string | null;
  detail: string | null;
};

export const auditScope = new AsyncLocalStorage<AuditEntry[]>();

export function recordAudit(entry: AuditEntry): void {
  auditScope.getStore()?.push(entry);
}
