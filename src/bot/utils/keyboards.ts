import { Keyboard } from "grammy";
import { t, type Language } from "../../shared/i18n/index.js";

export const buildMainMenuKeyboard = (lang: Language): Keyboard =>
  new Keyboard()
    .text(t(lang, "menu.create_test"))
    .text(t(lang, "menu.join_test")).row()
    .text(t(lang, "menu.my_tests"))
    .text(t(lang, "menu.my_stats")).row()
    .text(t(lang, "menu.settings"))
    .text(t(lang, "menu.my_classes")).row()
    .text(t(lang, "menu.language"))
    .row()
    .text(t(lang, "menu.help"))
    .resized()
    .persistent();
