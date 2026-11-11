/** Copy for the subscription-account sign-in section of the Models page. Lam Hy ships English only. */

/** Locale keys the section renders. */
export type SignInLocaleKey =
  | 'title' | 'intro' | 'loadFailed' | 'retry'
  | 'signIn' | 'signOut' | 'signedIn' | 'notSignedIn'
  | 'dialogTitle' | 'close' | 'cancel' | 'submit' | 'tryAgain' | 'done'
  | 'starting' | 'openPage' | 'copyLink' | 'copyCode' | 'copied' | 'code'
  | 'authorized' | 'cancelled' | 'failed' | 'connectionFailed'
  | 'signOutTitle' | 'signOutDescription' | 'signOutConfirm' | 'signOutFailed'

/** English copy. */
export const en: Record<SignInLocaleKey, string> = {
  title: 'Subscription accounts',
  intro: 'Sign in with an account plan to use its models without an API key.',
  loadFailed: "Couldn't load the account list.",
  retry: 'Retry',
  signIn: 'Sign in',
  signOut: 'Sign out',
  signedIn: 'Signed in',
  notSignedIn: 'Not signed in',
  dialogTitle: 'Sign in to {label}',
  close: 'Close',
  cancel: 'Cancel',
  submit: 'Continue',
  tryAgain: 'Try again',
  done: 'Done',
  starting: 'Starting sign-in…',
  openPage: 'Open sign-in page',
  copyLink: 'Copy link',
  copyCode: 'Copy code',
  copied: 'Copied',
  code: 'Code',
  authorized: 'Signed in. Its models now appear in the model picker.',
  cancelled: 'Sign-in cancelled.',
  failed: 'Sign-in failed.',
  connectionFailed: "Couldn't reach Lam Hy. Check the connection and try again.",
  signOutTitle: 'Sign out of {label}?',
  signOutDescription: 'This removes the saved sign-in from this computer. Its models disappear from the model picker until you sign in again.',
  signOutConfirm: 'Sign out',
  signOutFailed: "Couldn't sign out. Your saved sign-in may still be present. Try again.",
}
