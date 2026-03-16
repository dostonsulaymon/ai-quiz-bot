# UX Audit — Quiz Bot
## Executive Summary
This bot is feature-rich, but the first-time user experience is still rough and inconsistent. The strongest part is the core private test loop once a user is already inside it, but the bot does a poor job of explaining itself, guiding users between modes, and protecting them from dead ends or confusing state transitions.

The biggest UX weakness is state clarity. The bot often assumes the user understands whether they are creating, reviewing, editing, taking, or joining a test, but the messages and buttons do not consistently reinforce that context. For an Uzbek-first audience, the localization coverage is decent, but discoverability is weak and several flows still feel like internal tooling exposed directly to end users.

The biggest product risk is that the bot behaves like several semi-connected tools instead of one coherent experience. There are too many places where the user gets a generic prompt, silent failure, or a mode change without enough explanation. That will hurt trust fast, especially when AI generation fails or when users operate in groups.

## Critical Issues (must fix)
1. Idle-state random messages are effectively ignored.
If a new user sends a normal message without using a command, there is no meaningful fallback. From a first-time user perspective, the bot can feel dead.

2. `/newtest` can be triggered in a group chat and starts the upload flow publicly.
That is a serious UX and privacy failure. Users can end up uploading study materials into a group by mistake.

3. The AI failure state is mismatched with the visible UI.
After generation fails, the user sees a `Retry generation` button, but internally the bot moves back to `waiting_types`. That is brittle and confusing, and it increases the chance of odd behavior if the user interacts with older keyboards.

4. There is no proper first-time onboarding.
`/start` only says `Welcome to Quiz Bot. Use /newtest to create a quiz or /join SHARECODE to take a shared one.` This does not explain the product well enough, does not show examples, and does not guide the Uzbek primary audience into the most common next step.

5. The test-answer feedback is too easy to miss.
For MCQ and True/False, the bot edits the current message with feedback and immediately sends the next question. That makes the correctness feedback feel rushed and disposable.

6. Group quiz host permissions are not explained upfront.
The host-only `Next ▶` restriction is enforced, but participants only learn it after tapping and getting rejected. That feels arbitrary.

## Major Issues (should fix)
1. The upload flow is too long and under-explained.
It asks for file, count, types, shuffle, timer, then action choice. The user is making many decisions before seeing any value.

2. The action menu after generation is not self-explanatory enough.
`✅ Start Test`, `👁 Review Questions`, and `💾 Save & Share` appear suddenly without telling the user what the tradeoff is.

3. The review flow lacks a clear “keep this and continue” concept.
Users must infer that `Prev` and `Next` mean “accept this question as-is”.

4. `/language` exists, but it is not discoverable in the natural product flow.
It is only really visible through `/help` or the command list.

5. `/mytests` is useful but overloaded.
Each test can show take, share, delete, preview, edit, and sometimes leaderboard. In Telegram, this becomes visually dense quickly.

6. Group quiz open-answer questions are weakly handled.
Correct text answers get a reply, but wrong ones do not receive a direct reply. That can feel broken.

7. The edit flow feels like an admin tool, not a user product.
It is powerful, but the wording and step structure are functional rather than friendly.

## Minor Issues (nice to fix)
1. The welcome and help copy is dry and generic.
2. Pagination controls are functional but not pleasant.
3. Some English phrasing is too literal for Uzbek product UX.
4. Test preview cards do not show timer or shuffle settings.
5. Score cards do not show time taken.
6. Leaderboard discovery is still too dependent on edge conditions like at least two participants.
7. `/history` detail views can become long and heavy in Telegram.

## Flow-by-Flow Analysis
### 1. Onboarding Flow
Rating: 2/5

What works:
- `/start` is short and clear in a technical sense.
- Deep-link support exists for shared tests.
- Language switching exists as a separate command.

What doesn’t:
- The welcome text is too thin: `Welcome to Quiz Bot. Use /newtest to create a quiz or /join SHARECODE to take a shared one.`
- It does not explain the core value proposition: create quizzes from PDF/images, review AI-generated questions, share privately or use them in groups.
- It does not show example commands.
- If a user sends a random message while idle, there is effectively no helpful fallback.
- For Uzbek users, defaulting to English until language is set or detected well is a weak first impression.

Recommendations:
- Replace `/start` with a clearer two-step onboarding message.
- Show one primary CTA: `Create a Test`.
- Add a secondary CTA: `Join a Test`.
- Add a catch-all idle reply like: “Men test yaratish yoki testga qo‘shilish uchun ishlayman. /newtest yoki /join dan foydalaning.”

### 2. Test Creation Flow (`/newtest`)
Rating: 3/5

What works:
- The file prompt is clear.
- Wrong file types are rejected with understandable copy.
- File size validation exists.
- The bot supports both PDF and images.
- Question count and type selection are structured with buttons.

What doesn’t:
- The flow is long: file -> count -> types -> shuffle -> timer -> generation -> action menu.
- The shuffle step asks `Should questions and answers be shuffled each time the test is taken?` before the user has even seen the generated questions.
- The timer step is also asked too early, before the user knows whether the test is worth keeping.
- If AI generation fails, the user gets `I couldn't generate questions...` plus a retry button, but the internal state goes backward to type selection logic. That is unstable UX.
- The action menu `✅ Start Test`, `👁 Review Questions`, `💾 Save & Share` has no explanation of when to choose which.
- The bot can absolutely let a user get stuck in a muddy state if old inline keyboards remain active.
- `/newtest` in a group chat is a bad experience and should be blocked.

Recommendations:
- Move shuffle and timer settings after generation, ideally into the action menu or a settings submenu.
- Add one line above the action menu: `You can review questions, start immediately, or save and share the test.`
- Keep retry in the generation state, not the type-selection state.
- Hard-block `/newtest` in groups and redirect users to DM.

### 3. Review Flow
Rating: 3/5

What works:
- The question card format is readable.
- `✏️ Edit answer`, `🔄 Regenerate`, and `🗑️ Delete` are obvious enough.
- `✅ Start Test ({n} questions)` keeps the current total visible.
- If all questions are deleted, the bot offers `🔄 Regenerate all`.

What doesn’t:
- There is no explicit “Looks good / Keep” action. Users must infer that pressing `Next ▶` means accept.
- The review card does not reassure the user that they can keep moving without changing anything.
- `No questions remain. Tap Regenerate all...` is technically correct, but there is no obvious escape path back to upload or save flow.
- Regeneration has no contextual explanation such as “same source, same question type”.

Recommendations:
- Add a line like `If this looks good, tap Next.` on the first review card.
- Add a dedicated `✅ Keep` button or rename navigation to `Keep & Next`.
- Add a secondary option when all questions are deleted: `Cancel Review`.

### 4. Test Taking Flow (private)
Rating: 4/5

What works:
- The progress header is strong: `Question {n} of {total} [{bar}] {pct}%`.
- The progress bar is genuinely useful in Telegram.
- MCQ and True/False buttons are clean.
- Short/fill self-grading is understandable.
- The final score card is readable and emotionally satisfying.
- Retake, share, and main menu actions are clear.

What doesn’t:
- Feedback is too brief because the bot advances immediately after editing the answer result.
- Self-grading adds an extra message, which is fine, but the original question and grading prompt can create visual clutter.
- The score card does not show time taken, even though timing data exists.
- The user’s answer is not reflected inline for multiple-choice questions after submission.

Recommendations:
- Add a short delay before the next question, or wait for a `Next` tap.
- Show “Your answer: X” for wrong answers.
- Add total time on the completion card.

### 5. Group Quiz Flow
Rating: 2.5/5

What works:
- Starting a group quiz through `/join CODE` in a group is workable.
- The group intro `🎮 Group quiz started!` is clear.
- Answer feedback via callback alert is fast.
- Final results with medals are readable.

What doesn’t:
- This flow is not discoverable. Nothing in `/start` or `/help` explains that `/join CODE` behaves differently in groups.
- The host-only `Next ▶` rule is not explained before users hit it.
- Wrong open-ended text answers in groups get no user-facing feedback.
- The group question layout is readable, but there is no strong host marker like “Only the host can advance”.
- The leaderboard and group result systems overlap conceptually but are not explained as separate things.

Recommendations:
- Tell the group what is happening at start: who the host is, how answering works, and that only the host can move to the next question.
- Add a host badge in the intro.
- Reply to wrong open-ended answers privately where possible, or at least acknowledge them.

### 6. Share & Join Flow
Rating: 4/5

What works:
- Share code and deep-link generation are intuitive.
- The preview card before joining is useful.
- `/join` without an argument prompts for a code cleanly.
- `▶️ Start Test` and `❌ Cancel` are clear.

What doesn’t:
- `/start` only treats `TEST-...` payloads as deep links, which is okay for bot-generated links but less flexible than it could be.
- The preview card omits useful information like timer, shuffle, and whether the test is creator-owned.
- `Created by: Unknown creator` is weak social proof if no username exists.

Recommendations:
- Accept bare six-character deep-link payloads too.
- Add optional metadata to the preview: timer, shuffle, question source.

### 7. Leaderboard Flow
Rating: 3.5/5

What works:
- The text format is readable in Telegram.
- Medals for top 3 are motivating.
- Showing the user’s own rank outside the top 10 is a good choice.

What doesn’t:
- Discoverability is weak. Many users will never know this feature exists.
- The leaderboard only appears when there are at least two participants, so the button is inconsistent.
- Time is only shown if any entry has non-zero time, which is logical but not obvious.

Recommendations:
- Mention leaderboard in the score card even before it becomes available.
- Add `/leaderboard` to onboarding examples.

### 8. My Tests (`/mytests`)
Rating: 3.5/5

What works:
- The card text is informative.
- `Taken X times` is useful.
- Pagination edits in place, which is good for Telegram.
- Share/delete/preview/edit are all available.

What doesn’t:
- Too many actions compete visually.
- `▶️ Take 1` style numbering on buttons is functional but slightly awkward.
- There is no lightweight summary line telling the user what they can do on this screen.
- If a user owns many tests, the repeated rows and buttons can become mentally heavy.

Recommendations:
- Simplify the button layout.
- Group secondary actions behind a `More` submenu.
- Surface `Leaderboard` more consistently, not only when participant count is at least two.

### 9. History (`/history`)
Rating: 3.5/5

What works:
- The list is useful.
- Score, date, and question count are the right summary fields.
- Detail view with per-question breakdown is meaningful.

What doesn’t:
- `View Details 1`, `View Details 2` is functional but clunky.
- Detail view can get long fast and may feel dense on mobile Telegram.
- There is no summary of what kinds of mistakes the user tends to make.

Recommendations:
- Shorten the detail button label.
- Consider chunking very long detail views.
- Add optional “Retake this test” from history details.

### 10. Language Switching (`/language`)
Rating: 3/5

What works:
- The switch itself is fast.
- The keyboard is simple.
- Confirmation is instant.

What doesn’t:
- It is not discoverable in the main journey.
- There is no persistent entry point in the UI except the command list and `/help`.
- If the user starts in the wrong language, the bot gives them little guidance.

Recommendations:
- Add language buttons to `/start`.
- For Uzbek audience, consider defaulting to Uzbek when Telegram language suggests it.

### 11. Error States
Rating: 3/5

What works:
- Global errors are translated.
- Session corruption recovery exists.
- File download timeout has a custom message.
- `/cancel` exists and generally works.

What doesn’t:
- Some messages are too generic: `Something went wrong on my side. Please try again in a moment.`
- The retry UX is inconsistent. Sometimes users get a retry button, sometimes a plain error message.
- On bot restart mid-flow, the session recovery message is just a generic error string in `createBot`, not the more human-friendly restart-specific explanation users need.
- `/cancel` in testing can produce a score summary, which is good, but other stages only get a generic reset confirmation.

Recommendations:
- Make restart recovery explicit: “The bot restarted, so your previous step was lost.”
- Normalize retry behavior.
- Add context to errors: upload error, generation error, share error, join error.

### 12. Edge Cases
Rating: 2.5/5

What works:
- Joining a non-existent share code is handled cleanly: `This test link is expired or invalid ❌`
- Zero-question review state is handled.
- Rate-limit and session corruption protections exist.

What doesn’t:
- `/newtest` while already in a test is disruptive and not gracefully explained.
- `/newtest` in a group chat is still a serious UX problem.
- If the test has zero questions after editing, the edit flow pushes the user into add-question mode without enough explanation.
- Silent idle behavior remains the biggest edge-case problem because users will hit it constantly.

Recommendations:
- Warn users before abandoning an active test to start a new one.
- Block private-authoring flows in groups.
- Add explicit zero-question guidance in edit mode.

## Missing Features
1. A proper onboarding menu with buttons.
2. An idle-state fallback for random user messages.
3. A clear “resume or restart” flow when the user interrupts an active test.
4. A visible group-quiz explainer.
5. A compact settings summary before generation or before test start.
6. A friendlier empty state for `/mytests`, `/history`, and leaderboard discovery.
7. Better sharing UX after `Save & Share`, ideally with buttons instead of plain text only.
8. A “take again from history” shortcut.
9. A lightweight tutorial for editing and review actions.
10. Better Uzbek-first product copy. The translations are serviceable, but some phrasing still reads like direct engineering translation rather than polished product language.

## Positive Observations
1. The bot has strong functional depth. It already covers private tests, review, sharing, group quizzes, editing, history, and leaderboards.
2. The progress bar in tests is one of the best pieces of UX in the whole product.
3. The private score card is clear and motivating.
4. The review card layout is readable and Telegram-friendly.
5. The localization infrastructure is in place and broad enough to support real bilingual UX.
6. Pagination is handled with in-place message edits instead of chat spam.
7. The share-preview step before joining is a good trust-building pattern.

## Priority Fix List
1. Add a proper idle fallback so random first-user messages get a helpful response instead of silence.
2. Block `/newtest` and the upload flow in group chats; redirect users to DM.
3. Rewrite `/start` into a real onboarding screen with clear examples and buttons for `Create Test`, `Join Test`, and `Language`.
4. Fix the AI failure state so retry stays in one coherent generation state.
5. Slow down or gate private-test question advancement so answer feedback is actually visible.
6. Explain group quiz rules upfront, especially host-only next-step control.
7. Move shuffle and timer choices later in the creation flow, after question generation or inside settings.
8. Make the action menu after generation more explanatory.
9. Improve language discoverability and bias the first-run experience toward Uzbek users.
10. Simplify `/mytests` action density and improve leaderboard discoverability across the product.
