/**
 * The screens that exist as a route and not yet as an implementation.
 *
 * A union rather than a free string so the router cannot point at a placeholder topic
 * with no heading, and so the message-key maps in `PlaceholderView.vue` stay total.
 */
export const PLACEHOLDER_TOPICS = [
  'styleLab',
  'story',
  'characters',
  'assets',
  'timeline',
  'render',
] as const;

export type PlaceholderTopic = (typeof PLACEHOLDER_TOPICS)[number];
