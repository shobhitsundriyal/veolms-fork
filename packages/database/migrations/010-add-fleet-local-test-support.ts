import type { Kysely } from "kysely";

/**
 * Compatibility placeholder for databases that ran the old, prematurely
 * numbered fleet migration. The fleet test schema is applied by the later
 * timestamped migration so fresh and existing databases share the same order.
 */
export async function up(_database: Kysely<unknown>): Promise<void> {}

export async function down(_database: Kysely<unknown>): Promise<void> {}
