/**
 * Tool-approval sub-machine for the interactive chat channel: answers the
 * `approval/request` waterfall for this channel's agent only, presents one
 * approval dialog at a time in FIFO order, and settles each request on choice,
 * abort, overlay error, or channel shutdown.
 * @module @deepseek-ai/dsh-tui/approval
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ApprovalOutcome,
  ApprovalRequest,
} from '@deepseek-ai/dsh-user-approval'
import type { TuiOverlaySession } from './extension/types.ts'
import { ApprovalDialog } from './components/dialogs.ts'
import type { ChatChannelDeps } from './chat/channel.ts'

/** One queued or active approval request awaiting the user's choice. */
interface PendingApproval {
  request: ApprovalRequest
  resolve(outcome: ApprovalOutcome): void
  onAbort: () => void
  overlay: TuiOverlaySession | undefined
}

/** Collaborators the approval queue needs from the chat channel. */
export interface ApprovalQueueDeps extends ChatChannelDeps {
  /** The agent this channel answers for; other agents' requests pass through. */
  readonly agent: Agent
  /** Current row budget after reserving the editor. */
  approvalMaxHeight(): number
}

/** Tool-approval controller for one chat channel. */
export interface ApprovalQueue {
  /** Settle the active and all queued requests as 'cancelled' (shutdown). */
  rejectAll(): void
  /** Remove the waterfall answerer registration. */
  unregister(): void
}

/**
 * Build the tool-approval queue for one chat channel.
 * @param deps - channel collaborators and overlay host.
 * @returns the controller used at shutdown to drain and unregister.
 */
export function createApprovalQueue(deps: ApprovalQueueDeps): ApprovalQueue {
  const { ctx, agent, resolved, palette, overlayManager } = deps
  const approvalQueue: PendingApproval[] = []
  let activeApproval: PendingApproval | undefined

  const removeAbortListener = (pending: PendingApproval): void => {
    pending.request.signal?.removeEventListener('abort', pending.onAbort)
  }

  const settleApproval = (pending: PendingApproval, outcome: ApprovalOutcome): void => {
    void pending.overlay?.close()
    pending.overlay = undefined
    removeAbortListener(pending)
    pending.resolve(outcome)
  }

  const startNextApproval = (): void => {
    if (activeApproval !== undefined || deps.isDisposed()) return
    const pending = approvalQueue.shift()
    if (pending === undefined) return
    activeApproval = pending
    const request = pending.request
    const session = overlayManager.open({
      ...request.signal === undefined ? {} : { signal: request.signal },
      create: () => new ApprovalDialog(
        request.toolName,
        request.reason,
        () => deps.approvalMaxHeight(),
        palette,
        (choice) => {
          activeApproval = undefined
          settleApproval(pending, choice)
          startNextApproval()
        },
        () => {
          activeApproval = undefined
          settleApproval(pending, 'cancelled')
          startNextApproval()
        },
      ),
      options: {
        width: resolved.questionDialogWidth,
        maxHeight: resolved.questionDialogMaxHeight,
      },
    }, 'inline')
    pending.overlay = session
    void session.closed.then((result) => {
      if (pending.overlay !== session) return
      pending.overlay = undefined
      /* v8 ignore next 2 -- close, abort, and shutdown settle the owner before this callback */
      if (result.reason !== 'error') return
      activeApproval = undefined
      removeAbortListener(pending)
      // A failed render is a host failure, not a user choice: settle with the
      // fail-closed vocabulary so the asker sees a definitive outcome.
      pending.resolve('unavailable')
      startNextApproval()
    })
    deps.requestRender()
  }

  const unregister = ctx.on('approval/request', (request, next) => {
    // Answer only for the channel's own agent; other agents' requests fall
    // through to the rest of the waterfall (e.g. the host's proxy).
    if (request.agent !== agent) return next()
    return new Promise<ApprovalOutcome>((resolve) => {
      // Dispatch rides a microtask behind the service's own signal check: an
      // abort landing in that window would register the abort listener AFTER
      // the signal fired — never invoked, entry pending forever. Settle
      // synchronously instead of publishing.
      if (request.signal?.aborted === true) {
        resolve('cancelled')
        return
      }
      const pending: PendingApproval = {
        request,
        resolve,
        overlay: undefined,
        onAbort: () => {
          if (activeApproval === pending) {
            activeApproval = undefined
            settleApproval(pending, 'cancelled')
            startNextApproval()
            return
          }
          // A non-active pending request remains in the queue until this listener settles it.
          approvalQueue.splice(approvalQueue.indexOf(pending), 1)
          settleApproval(pending, 'cancelled')
        },
      }
      request.signal?.addEventListener('abort', pending.onAbort, { once: true })
      approvalQueue.push(pending)
      startNextApproval()
    })
  })

  return {
    rejectAll(): void {
      if (activeApproval !== undefined) {
        const pending = activeApproval
        activeApproval = undefined
        settleApproval(pending, 'cancelled')
      }
      for (const pending of approvalQueue.splice(0)) settleApproval(pending, 'cancelled')
    },
    unregister,
  }
}
