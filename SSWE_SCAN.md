# User Comfort Audit

## Executive Summary
Overall comfort is mediocre: the bot is functional, but too many flows make users work harder than necessary and several endings leave them stranded. The biggest pain point is the test-creation funnel, which asks for too many decisions before the first question and offers weak recovery once the user is inside text-entry subflows. The quickest win is to add explicit next-step keyboards to every completion, empty, cancel, and error state.

## 1. Dead Ends
- `src/bot/handlers/upload.handler.ts | handleWaitingAction` save branch: user sees `Your test is saved!` plus raw share instructions, but no buttons to `Start test`, `Copy link`, `My tests`, or `Main menu`. They should see a keyboard with those next steps.
- `src/bot/handlers/test.handler.ts | runAutoAdvance` last-question timeout path: user sees a plain completion summary with score, then nothing. They should see the same completion keyboard as normal completion: `Review answers`, `Share`, `Retake`, `Main menu`.
- `src/bot/handlers/test.handler.ts | handleCompleted` `MAIN_MENU_CALLBACK`: user sees `Back to the main menu...` as plain text, but no actual main menu keyboard. They should get the persistent main menu keyboard immediately.
- `src/bot/handlers/mytests.handler.ts | showMyTestsPage`: if the user has no tests, they only get `You haven't created any tests yet.` They should get a `Create Test` button.
- `src/bot/handlers/history.handler.ts | bot.command("history")`: if the user has no sessions, they only get `You haven't taken any tests yet.` They should get `Create Test` and `Join a Test`.
- `src/bot/handlers/commands.ts | buildStatsMessage` empty state used by `/stats` and menu stats: `No stats yet` has no next action. It should include `Create Test`, `Join a Test`, and `My Tests`.
- `src/bot/handlers/classes.handler.ts | MYCLASSES_SHARE_PREFIX callback`: user gets a plain class share message, detached from the class screen, with no back button and no quick share action. They should get an inline keyboard with `Open link`, `Back to class`, and `Back to classes`.
- `src/bot/handlers/commands.ts | JOIN_CANCEL_CALLBACK`: user gets `Join cancelled.` and nothing else. They should get `Join another test`, `Create test`, and `Main menu`.
- `src/bot/middlewares/errorMiddleware.ts | registerErrorMiddleware`: non-retryable errors produce plain text only. They should still offer an escape route like `Main menu` or `Start over`.

## 2. Missing Confirmations
- `src/bot/handlers/settings.handler.ts | SETTINGS_COUNT_PREFIX callbacks`: question count updates by silently redrawing the settings page. Expected feedback: `Default question count saved`.
- `src/bot/handlers/settings.handler.ts | SETTINGS_TYPES_CONFIRM_CB`: types save with no explicit confirmation. Expected feedback: `Default question types saved`.
- `src/bot/handlers/settings.handler.ts | SETTINGS_TIMER_PREFIX callbacks`: timer saves with no explicit confirmation. Expected feedback: `Default timer saved`.
- `src/bot/handlers/settings.handler.ts | SETTINGS_SHUFFLE_PREFIX callbacks`: shuffle saves with no explicit confirmation. Expected feedback: `Default shuffle saved`.
- `src/bot/handlers/settings.handler.ts | settingsAwaitingCustomCount` text handler: custom count saves by sending the settings page, but never says it worked. Expected feedback: `Default question count set to N`.
- `src/bot/handlers/review.handler.ts | handleEditingAnswer`: answer edits update the review card but never confirm the edit. Expected feedback: short toast or message like `Answer updated`.
- `src/bot/handlers/edit.handler.ts | handleTitle`: title changes bounce back to menu with no explicit `Title updated`. Expected feedback: `Title updated`.
- `src/bot/handlers/edit.handler.ts | handleEditingAnswer`: answer edits update the card but never acknowledge success. Expected feedback: `Correct answer updated`.
- `src/bot/handlers/classes.handler.ts | class create/edit text handler`: creating or renaming a class jumps to the class view with no `Class created` or `Class renamed`. Expected feedback: a short confirmation.
- `src/bot/handlers/group.handler.ts | processGroupChoiceAnswer / handleGroupPollAnswer`: native poll answers in group mode record silently; users depend on Telegram poll behavior instead of bot feedback. Expected feedback: at least a lightweight per-user toast or visible answered count update that feels immediate.

## 3. Confusing Button Labels
- `src/bot/handlers/mytests.handler.ts | renderMyTestsPage` | `⋯ More` | Too vague; user has no idea if this means edit, export, delete, or preview. Better label: `Manage`.
- `src/bot/handlers/mytests.handler.ts | renderShareView` | `📋 Copy link` | It opens a URL; it does not copy anything. Better label: `Open Share Link`.
- `src/bot/handlers/settings.handler.ts | buildSettingsKeyboard` | `↩️ Done` | It sounds like exit, but it just redraws the settings page. Better label: `Close Settings` or actually exit to main menu.
- `src/bot/handlers/upload.handler.ts | buildQuestionTypesKeyboard` | `[Confirm selection]` | Brackets feel system-generated and low-trust. Better label: `Done`.
- `src/bot/handlers/group.handler.ts | buildQuestionKeyboard` | `Next ▶ ({answered} answered)` | It hides that only the host can use it and that it reveals results then advances. Better label: `Host: Show Results`.
- `src/bot/handlers/mytests.handler.ts | renderPreview / renderMyTestsPage` | `Take` vs `Take Test` | Same action, two labels. Better label: use `Start Test` everywhere.
- `src/bot/handlers/classes.handler.ts | renderMyClassesPage` | `View` | For owners this is really class management, not a simple view. Better label: `Open Class`.
- `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts` | `mcq / truefalse / short / fill` in `edit.add.type_prompt` | Raw internal jargon. Better label: `Multiple choice / True-False / Short answer / Fill in the blank`.

## 4. Flow Length Analysis

| Flow | Tap count | Too long? | Where to reduce |
| --- | ---: | --- | --- |
| `/newtest` -> first question appearing | 6 minimum after upload | Yes | Collapse count, type, shuffle, timer, and title into one compact setup screen or reuse defaults automatically with one `Start now` shortcut |
| Receiving share link -> first question appearing | 1 | No | Fine as-is |
| Completing a test -> sharing the result | 1-2 | No | Fine as-is |
| `/mytests` -> starting a saved test | 1 | No | Fine as-is |
| `/myclasses` -> taking a test from a class | Not possible from own class list | Yes | Add `Start Test` directly inside class view for owners; current owned-class flow is management-only |
| `/settings` -> changing question count default | 2 preset, 3 custom | No | Fine, but add confirmation and a back route for custom input |

## 5. Information Overload
- `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts` `start.welcome_new`: 10+ lines before the user acts. This is skimmable marketing copy, not a crisp first-run screen.
- `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts` `start.welcome_returning`: long stat block before action, even though the user probably wants to continue immediately.
- `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts` `commands.help`: dense command dump; most users will not read it fully.
- `src/bot/handlers/mytests.handler.ts | renderMyTestsPage`: 5 tests x 3 action buttons + pagination produces 16 buttons on one screen. That is too much scanning.
- `src/bot/handlers/classes.handler.ts | renderMyClassesPage`: 5 classes x 4 action buttons + `New Class` + pagination creates a very crowded keyboard.
- `src/bot/handlers/history.handler.ts | renderHistoryDetails`: full per-question breakdown can become extremely long for larger tests and is hard to scan in chat.
- `src/bot/handlers/upload.handler.ts | runGeneration` ready screen: summary plus three descriptive lines plus action buttons is acceptable, but it is another verbose message in an already long funnel.

## 6. Missing Escape Routes
- `src/bot/handlers/upload.handler.ts | handleWaitingCountCustom`: no local `Back` or `Cancel`; user must know `/cancel`.
- `src/bot/handlers/settings.handler.ts | SETTINGS_COUNT_CUSTOM_CB` text-entry mode: no back button and no prompt that `/cancel` is available.
- `src/bot/handlers/classes.handler.ts | MYCLASSES_NEW_CB` and class edit text mode: once prompted for a title, there is no visible cancel route.
- `src/bot/handlers/review.handler.ts | handleEditingAnswer`: once asked to type a replacement answer, there is no local `Cancel`.
- `src/bot/handlers/edit.handler.ts | handleTitle`: title-edit mode has no visible cancel or back.
- `src/bot/handlers/edit.handler.ts | handleAddingQuestion`: multi-step add-question flow has no local back/cancel at any stage.
- `src/bot/handlers/commands.ts | /join` pending code mode: user is told to send a code, but no cancel button is offered.
- `src/bot/handlers/upload.handler.ts | transitionToWaitingTitle`: title step offers only `Skip`; there is no route back to timer/shuffle/count decisions.

## 7. Inconsistent Behavior
- `src/bot/handlers/mytests.handler.ts | renderDeleteConfirm` vs `src/bot/handlers/classes.handler.ts | MYCLASSES_DELETE_PREFIX`: tests ask for delete confirmation; classes delete immediately. These should behave the same.
- `src/bot/handlers/test.handler.ts | completeTest` vs `runAutoAdvance`: normal completion has a rich action keyboard; timeout completion does not. Same outcome, different comfort.
- `src/bot/handlers/mytests.handler.ts | renderShareView` vs `src/bot/handlers/classes.handler.ts | MYCLASSES_SHARE_PREFIX`: test sharing is an inline managed screen with back; class sharing is a detached text dump.
- `src/bot/handlers/classes.handler.ts | renderMyClassesPage` empty state vs `src/bot/handlers/mytests.handler.ts | showMyTestsPage` empty state vs `/history` and `/stats`: some empty states give next-step UI, others do not.
- `src/bot/handlers/settings.handler.ts`: submenu screens consistently include `Back`, but text-entry subflows in upload, class creation, review edit, and edit mode do not.
- `src/bot/handlers/mytests.handler.ts | renderPreview` and list rows: `Take`, `Take Test`, `Share`, `More`, `Preview` are inconsistent in specificity.

## 8. Timing Issues
- `src/bot/handlers/mytests.handler.ts | export callback`: PDF export only gives a temporary callback toast. If generation takes several seconds, the bot feels stalled. Use a persistent `Generating PDF...` message and replace it with the document.
- `src/bot/handlers/classes.handler.ts | MYCLASSES_SHARE_PREFIX`: share-code generation does DB work but shows no loading feedback. A short `Preparing share link...` toast would reduce uncertainty.
- `src/bot/handlers/commands.ts | /start` for returning users: it does multiple DB reads before replying, with no typing indicator. On slower infra this will feel dead.
- `src/bot/handlers/commands.ts | /stats` and stats menu: multiple DB reads with no progress feedback.
- `src/bot/index.ts | sessionRecovered` middleware: recovered sessions respond with a generic error only; after downtime, this feels like the bot forgot the user without explanation or next step.

## 9. First-Time User Confusion
- `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts` `commands.joinPromptCode`: `share code` is not explained or exemplified beyond format; new users may not know where it comes from.
- `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts` `commands.leaderboardPromptCode`: same problem; assumes users already understand share codes.
- `src/bot/handlers/upload.handler.ts | enterUploadFlow`: initial upload prompt does not say multiple images can be sent one by one until after the first image lands.
- `src/bot/handlers/test.handler.ts | handleTextAnswer`: open-answer questions suddenly switch into self-grading. That is a major behavioral shift with no early warning.
- `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts` `edit.add.type_prompt`: exposes internal format terms instead of user language.
- `src/bot/handlers/classes.handler.ts`: the owner-facing class screen is mostly management, not consumption. A user entering `/myclasses` may reasonably expect to take a test from there and cannot.
- `src/shared/i18n/en.ts` `error.rateLimit_concurrent`: `active test sessions` is backend language, not user language.

## 10. Language and Tone
- `src/shared/i18n/uz.ts | language.auto_prompt`: English text appears inside Uzbek copy. Rewrite to `🌐 Iltimos, tilni tanlang:`.
- `src/shared/i18n/uz.ts | language.selected.en`: `English tanlandi!` is mixed-language and stiff. Rewrite to `🇬🇧 Ingliz tili tanlandi!`.
- `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts | cmd.language`: `Language / Til` feels unfinished. Rewrite per locale: `Language` and `Til`.
- `src/shared/i18n/en.ts | error.userSession`: `User session missing.` is technical and cold. Rewrite to `I lost track of your progress. Please try again.`
- `src/shared/i18n/en.ts | test.sessionError`: `Session error. Please use /cancel and try again.` is technical and puts recovery burden on the user. Rewrite to `I lost this test session. Tap Start Over to continue.`
- `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts | commands.cancelled`: verbose and robotic. Rewrite to something shorter like `Cancelled. You can start again anytime.`
- `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts | start.welcome_*`: heavy emoji density and promotional tone clashes with colder system and error copy. Pick one stable voice.
- `src/shared/i18n/uz.ts | edit.add.type_prompt`: raw English abbreviations inside Uzbek reduce trust and feel machine-translated.

## Top 15 Fixes Ordered by User Impact
1. `High` | `src/bot/handlers/upload.handler.ts | handleWaitingAction` | Save flow ends as plain text | Add keyboard: `Start Test`, `Open Share Link`, `My Tests`, `Main Menu` | `S`
2. `High` | `src/bot/handlers/test.handler.ts | runAutoAdvance` | Timeout completion has no follow-up actions | Reuse normal completion keyboard on timeout completion | `S`
3. `High` | `src/bot/handlers/upload.handler.ts` creation funnel | New-test path needs 6 decisions before first question | Add one-tap `Use my defaults and start` shortcut | `M`
4. `High` | `src/bot/handlers/edit.handler.ts` and `src/bot/handlers/review.handler.ts` text subflows | Users enter input-only modes with no local cancel/back | Add inline `Cancel` and `Back` to every text-entry sub-step | `M`
5. `High` | `src/bot/handlers/classes.handler.ts | renderClassView` | Owner cannot start a class test from `/myclasses` | Add `Start Test` buttons per test inside class view | `M`
6. `High` | `src/bot/handlers/test.handler.ts | handleCompleted` `MAIN_MENU_CALLBACK` | `Main menu` does not show the menu | Send the real main menu keyboard | `S`
7. `High` | `src/bot/handlers/classes.handler.ts | MYCLASSES_DELETE_PREFIX` | Class deletion has no confirmation | Add confirm/cancel screen like test deletion | `S`
8. `Medium` | `src/bot/handlers/mytests.handler.ts | renderMyTestsPage` | Test list keyboard is overcrowded | Reduce per-row actions to `Start` and `Manage`; move share/export/delete into manage | `M`
9. `Medium` | `src/bot/handlers/classes.handler.ts | renderMyClassesPage` | Class list keyboard is overcrowded | Reduce to one primary action per class plus `Manage` | `M`
10. `Medium` | `src/bot/handlers/settings.handler.ts` | Setting changes save silently | Add concise confirmation toasts/messages for each setting change | `S`
11. `Medium` | `src/bot/handlers/mytests.handler.ts | export callback` | Long export uses only a fading toast | Add persistent loading message and replace it with the PDF | `S`
12. `Medium` | `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts` | `More`, `Copy link`, `[Confirm selection]`, raw type jargon are unclear | Rename labels to concrete action names | `S`
13. `Medium` | `src/bot/handlers/mytests.handler.ts`, `history.handler.ts`, stats command | Empty states are dead ends | Add CTAs to create, join, or return home | `S`
14. `Medium` | `src/shared/i18n/uz.ts` language/tone issues | Uzbek copy mixes English and machine-like phrasing | Rewrite the affected strings for native clarity | `S`
15. `Medium` | `src/shared/i18n/en.ts` and `src/shared/i18n/uz.ts` join/share-code copy | Assumes prior knowledge of share codes | Add one-line explanation and example everywhere codes are requested | `S`

## Quick Wins (can fix in one prompt)
- Add action keyboards to all current dead-end states: saved test, timeout completion, main menu, no tests, no history, empty stats, class share.
- Rename ambiguous labels: `More` -> `Manage`, `Copy link` -> `Open Share Link`, `[Confirm selection]` -> `Done`, `View` -> `Open Class`.
- Add local `Cancel` or `Back` buttons to custom count, join-code entry, class title entry, review answer edit, edit title, and add-question subflows.
- Make class delete use the same confirmation pattern as test delete.
- Add short save confirmations for every settings change instead of only on `Done`.
- Rewrite the worst technical/cold strings: `User session missing`, `Session error`, `commands.cancelled`.
- Fix mixed-language Uzbek strings under language selection and edit prompts.
