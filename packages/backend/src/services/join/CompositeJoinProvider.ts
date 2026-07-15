/**
 * CompositeJoinProvider — routes each join's index request to the right side-provider.
 *
 * The EntityJoinStep takes ONE provider, but a connection can mix dest-side joins (resolved
 * against the destination DB) and source-side joins (resolved by reading another source
 * entity). This composite dispatches `getIndex` by `join.entity.side`, so the step stays
 * side-agnostic and joins of both kinds can even chain together in one enrichment pass.
 */

import type { EntityIndex, EntityIndexProvider, JoinSpec } from '../../hub/entity-join-step';

export class CompositeJoinProvider implements EntityIndexProvider {
  constructor(private readonly bySide: { source?: EntityIndexProvider; dest?: EntityIndexProvider }) {}

  async getIndex(join: JoinSpec, signal: AbortSignal): Promise<EntityIndex> {
    const provider = this.bySide[join.entity.side];
    if (!provider) {
      throw new Error(`No join provider available for side "${join.entity.side}" (join "${join.alias}")`);
    }
    return provider.getIndex(join, signal);
  }
}
