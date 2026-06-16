/**
 * Standard envelope header keys — the connector-agnostic metadata contract.
 *
 * The bus core only knows these generic keys; no connector-specific fields ever
 * live on the envelope. Sources set EVENT/RECORD_ID; the mapping transform adds
 * NATURAL_KEY/NATURAL_KEY_COLUMN/DEST_TABLE; the run recorder sets RUN_ID.
 */
export const H = {
  EVENT: 'event',                       // created | updated | deleted
  RECORD_ID: 'recordId',                // the source record's natural id
  NATURAL_KEY: 'naturalKey',            // upsert/dedup value at the destination
  NATURAL_KEY_COLUMN: 'naturalKeyColumn',
  DEST_TABLE: 'destTable',              // optional per-message destination table
  RUN_ID: 'runId',
} as const;

export type ChangeEvent = 'created' | 'updated' | 'deleted';

export function eventOf(headers: Readonly<Record<string, string>> | undefined): ChangeEvent {
  const e = headers?.[H.EVENT];
  return e === 'created' || e === 'updated' || e === 'deleted' ? e : 'updated';
}
