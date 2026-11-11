/**
 * Subscription-account sign-in section, node half. The empty apply exists so
 * the plugin appears in the Host cordis.yml; the browser half owns the section
 * through exports["./client"].
 */

/** Host plugin body; this surface plugin has no Host-side behavior. */
export function apply(): void {}
