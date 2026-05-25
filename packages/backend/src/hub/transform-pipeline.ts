/**
 * TransformPipeline — runs an ordered chain of ITransformStep instances
 * against a MessageEnvelope.
 *
 * Each step receives the envelope output of the previous step.
 * If any step throws, the pipeline aborts and the error propagates.
 */

import type { MessageEnvelope, ITransformStep } from './interfaces';

export class TransformPipeline {
  private readonly steps = new Map<string, ITransformStep>();

  /**
   * Register a transform step by its stepId.
   */
  register(step: ITransformStep): void {
    this.steps.set(step.stepId, step);
  }

  /**
   * Execute the transform chain. stepIds are resolved in order.
   * Returns the final transformed envelope.
   */
  async execute(
    envelope: MessageEnvelope,
    stepIds: readonly string[],
    signal: AbortSignal,
  ): Promise<MessageEnvelope> {
    let current = envelope;

    for (const stepId of stepIds) {
      const step = this.steps.get(stepId);
      if (!step) {
        throw new Error(`Transform step "${stepId}" not registered in pipeline`);
      }

      current = await step.execute(current, signal);
    }

    return current;
  }

  /**
   * Check if a step is registered.
   */
  has(stepId: string): boolean {
    return this.steps.has(stepId);
  }

  /**
   * Get all registered step IDs.
   */
  get registeredSteps(): string[] {
    return Array.from(this.steps.keys());
  }
}
