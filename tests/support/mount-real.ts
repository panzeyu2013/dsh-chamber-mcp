/**
 * Shared real-service mount recipe for host suites on dsh 0.2.3.
 *
 * The 0.2.3 line adds sessionProjections to the SystemPrompt plugin's injects,
 * so a bare ctx.plugin(SystemPrompt) stays PENDING (fiber.await() resolves for a
 * pending fiber) and every downstream factory ctx is undefined. Mount the
 * projection registry first, then SystemPrompt, then the real ToolRuntime, then
 * the tools-injecting factory ctx that agent scopes derive from.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

/** Contexts the recipe provides. */
interface RealMount {
  /** The tools-injecting fiber ctx under which agent scopes are created. */
  readonly factoryCtx: Context
}

/** Recipe options. */
interface MountRealOptions {
  /**
   * Install the stub tool executor prompt assembly needs (seam/propmt tests):
   * dsh-system-prompt consults the selected executor for its tool description.
   */
  executor?: boolean
}

/** A no-op ToolExecutor: prompt assembly needs a selected executor, not a runner. */
function stubExecutor(): {
  describe(): { schemas: []; knownNames: [] }
  execute(): Promise<{ results: []; additionalContexts: []; concluded: false }>
} {
  return {
    describe: () => ({ schemas: [], knownNames: [] }),
    execute: async () => ({ results: [], additionalContexts: [], concluded: false }),
  }
}

/**
 * Mount real services and return the factory ctx.
 * @param ctx - root context of the suite.
 * @param options - optional stub prompt executor.
 * @returns the factory ctx under which agent scopes resolve tools.
 */
export async function mountReal(ctx: Context, options: MountRealOptions = {}): Promise<RealMount> {
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.executor === true) ctx.tools.setExecutor(stubExecutor() as never)
  let factoryCtx!: Context
  const factoryPlugin = function agentFactory(c: Context): void {
    factoryCtx = c
  }
  ;(factoryPlugin as unknown as { inject: string[] }).inject = ['tools']
  await ctx.plugin(factoryPlugin)
  return { factoryCtx }
}
