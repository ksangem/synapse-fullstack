/**
 * The distributed Integration Bus uses exactly TWO fixed BullMQ queues
 * (locked design decision #2 of SYNAPSE_UPGRADE_PLAN.md) — NOT per-subscription
 * queues. The dispatch job payload itself carries the subscription/destination,
 * so one shared dispatch queue + one Worker pool serves every integration
 * (per-subscription queues would mean one Worker per integration — racy).
 *
 *   hub-intake   — source publishes land here; the intake worker drains it and
 *                  hands each envelope to RouterService.route (topic fan-out).
 *   hub-dispatch — RouterService enqueues one job per matching subscription; the
 *                  dispatch worker transforms → idempotency → destination.dispatch.
 */
export const HUB_INTAKE_QUEUE = 'hub-intake';
export const HUB_DISPATCH_QUEUE = 'hub-dispatch';
