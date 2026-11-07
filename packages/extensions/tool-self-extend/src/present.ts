/** Pure replay-safe presentation for preset self-extension calls. */
import type { GenericCallView } from '@deepseek-ai/dsh-tools'

/** Present a self-extension operation without reading live profile state.
 * @param args Operation and optional row id.
 * @returns Replay-safe generic tool card.
 */
export function presentSelfExtendCall(args: { action: string; id?: string }): GenericCallView {
  if (args.action === 'list') return { card: 'generic', kind: 'read', title: 'List self extensions' }
  const verb = args.action === 'add' ? 'Add' : args.action === 'update' ? 'Update' : 'Remove'
  return { card: 'generic', kind: 'other', title: `${verb} self extension ${args.id ?? ''}`.trim(), rawInput: args }
}
