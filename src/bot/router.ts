import type { BotContext } from "./types.js";
import { uploadRouterFull } from "./handlers/upload.handler.js";
import { reviewRouter, enterReviewFlow } from "./handlers/review.handler.js";
import { testRouter, enterTestFlow } from "./handlers/test.handler.js";
import { editRouter } from "./handlers/edit.handler.js";
import { resetSession } from "./types.js";
import { t } from "../shared/i18n/index.js";

/**
 * Top-level state router.
 * Dispatches each incoming update to the handler matching ctx.session.state.
 * All states that need persistent conversation are handled here.
 */
export const stateRouter = async (ctx: BotContext, next: () => Promise<void>): Promise<void> => {
  const text = ctx.message?.text;
  if (text?.startsWith("/start") || text?.startsWith("/cancel") || text?.startsWith("/language")) {
    return next();
  }

  const state = ctx.session.state;

  if (state === "uploading" || state === "configuring") {
    await uploadRouterFull(ctx);

    // If the user chose "Review Questions" from the action menu, handleWaitingAction
    // sets state = "reviewing" and calls enterReviewFlow directly — nothing to do here.
    return;
  }

  if (state === "reviewing") {
    await reviewRouter(ctx);

    // If review was confirmed, saveTestAndTransition sets state = "testing".
    // The test flow handler will send the first question on the next update;
    // but since enterTestFlow does that immediately we need to call it here.
    // Check: if we just transitioned into "testing" from "reviewing", send first question.
    if (ctx.session.state === "testing" && ctx.session.testQuestionMessageId === undefined && !ctx.session.sessionId) {
      if (!ctx.session.activeTestId) {
        resetSession(ctx.session);
        await ctx.reply(t(ctx.lang(), "error.session_corrupted"));
        return;
      }
      await enterTestFlow(ctx, ctx.session.activeTestId);
    }
    return;
  }

  if (state === "testing") {
    await testRouter(ctx);
    return;
  }

  if (state === "editing") {
    await editRouter(ctx);
    return;
  }

  // idle / done / unknown — pass through to command handlers
  await next();
};
