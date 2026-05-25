/**
 * SharePointWebhookReceiver — PLACEHOLDER.
 *
 * TODO: Implement webhook subscription creation and validation endpoint.
 * SharePoint webhooks require:
 * 1. POST to /sites/{siteId}/lists/{listId}/subscriptions with notificationUrl
 * 2. Validation: SP sends a validationToken query param; respond with it as plain text
 * 3. On change notification: receive POST with subscriptionId + resource
 * 4. Fetch actual changes via delta query (same as polling, but triggered by webhook)
 *
 * This class is intentionally empty. The SharePointSourceConnector supports
 * triggerMode: 'delta' | 'webhook' in config; only 'delta' is implemented.
 * When 'webhook' mode is added, this class will handle Express route registration
 * and validation flow.
 */

export class SharePointWebhookReceiver {
  // TODO: implement webhook subscription management
  // TODO: implement Express route for validation + notification handling
}
