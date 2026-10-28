// Shared pieces of the confirm-gated write tools (messages, refill requests,
// appointment requests and cancellations). Each tool is a `defineWrite` —
// `plan` validates and reads, `execute` sends once — registered with
// `registerWrite`, so the preview/confirmToken gate is the shared one.

import {
  CONFIRM_INJECTION_RULE,
  minifiedResult,
  toolAnnotations,
  writeOrUnknown,
} from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Every write here reaches the practice, which sees it, and none has an undo
 * through this server: destructive, open-world.
 */
export const WRITE = toolAnnotations({ readOnly: false, destructive: true, openWorld: true });

/**
 * A write tool's description, with the injection rule appended (`registerWrite`
 * appends the confirm-flow sentence itself).
 */
export function writeDescription(text: string): string {
  return `${text} ${CONFIRM_INJECTION_RULE}`;
}

/** What a write reports when the portal never confirmed whether it happened. */
export interface UnknownOutcome {
  status: 'unknown';
  warning: string;
}

/**
 * Send a write once. A {@link WriteOutcomeUnknownError} (sent, then a 5xx or a
 * dropped connection) becomes an `unknown` outcome naming where to check,
 * instead of an error that reads as "safe to retry" — the confirm token is
 * already spent, and a retry would send the message or request twice.
 */
export async function sendOnce<T>(
  run: () => Promise<T>,
  what: string,
  checkWith: string,
): Promise<T | UnknownOutcome> {
  const outcome = await writeOrUnknown(run, (_err, reason): UnknownOutcome => ({
    status: 'unknown',
    warning:
      `InSync did not confirm this ${what} (${reason}), so it may already have gone through. ` +
      `Check ${checkWith} before retrying; do not resend blindly.`,
  }));
  return outcome.ok ? outcome.value : outcome.result;
}

/** The single tool's result: compact JSON. */
export function renderWrite(result: unknown): CallToolResult {
  return minifiedResult(result);
}
