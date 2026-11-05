# Interface languages

Drifting provides nine interface locales. Language is an interface preference;
changing it does not translate, normalize or rewrite authored text, entity names,
Markdown filenames, SQLite records or live Yjs prose.

| Locale | Picker label | Regional resolution |
| --- | --- | --- |
| `zh-CN` | 简体中文 | `zh`, `zh-Hans`, mainland China and Singapore |
| `zh-TW` | 繁體中文 | `zh-Hant`, Taiwan, Hong Kong and Macao |
| `en` | English | All English regions |
| `ja` | 日本語 | All Japanese regions |
| `ko` | 한국어 | All Korean regions |
| `es` | Español | Spain and Latin American regions |
| `de` | Deutsch | All German regions |
| `fr` | Français | All French regions |
| `pt-BR` | Português (Brasil) | Brazilian Portuguese; other Portuguese regions currently use this translation |

An explicit Chinese script (`Hans` or `Hant`) takes precedence over the region.
Unsupported languages fall back to English. With no saved choice, the first
supported language in `navigator.languages` is selected. Corrupt or unavailable
storage uses the same system-language path. A saved supported preference wins.
The preference sync allowlist accepts all nine canonical codes and continues to
ignore codes a client does not understand.

## Source owners

- `src/shared/ui-locales.ts` owns codes, native names, language matching and
  initialization. It has no React, native, account or database dependency.
- `src/renderer/locales/*.json` contains the application strings. The resource
  inventory and explicit-locale, non-React translator live in
  `src/renderer/lib/locale-resources.ts`; `lib/i18n.ts` attaches React and sets
  the document's `lang` and `dir` attributes on initial load and every switch.
- `src/share-web/locales/*.json` contains the independent share reader strings.
  The share reader follows browser language preferences, shares the locale
  registry and uses its own i18next instance. It does not import the renderer
  runtime or the application's much larger catalogs.
- `src/shared/startup-preferences.ts` supplies the pre-React loading label and
  theme. `pnpm locales:bootstrap` bundles it into `public/startup.js`; edit the
  TypeScript source and regenerate, rather than editing the generated file.
- `src/shared/locale-format.ts` uses `Intl` for compact counts and relative
  time. Other interface number/date formatting uses the selected UI language.
- Agent tool progress and permission descriptions are resource keys under
  `agentTools`. Targets, relation names and draft excerpts remain opaque
  interpolation values. Model-authored dialogue still follows the author's
  language and instructions; an interface locale is not a manuscript language.

The settings page and account menu use the existing searchable `GlassSelect`.
Nine native names do not fit a segmented slider. Its fixed-position listbox
portals to `body`, including when opened inside the account popover. Traditional
Chinese, Japanese and Korean prefer the corresponding system glyph families;
this does not change the author's manuscript-font preference. The character sea
also has Traditional Chinese and Hangul passages. Latin locales retain its Latin
script; this decorative passage is not manuscript text.

Inside the account menu, the language dropdown takes its content width rather
than the full form-field width, leaving room for the icon and language label.
The label stays on one line and the full selected native language name remains
visible across all five interface text sizes. The account menu grows with the
interface font size so the adjacent theme control retains its label space too.

## Translation contract

English is the missing-key fallback. Preserve interpolation names and formatting
inside `{{...}}`, links, markup, command names, shortcuts and file extensions.
Translate complete phrases; do not assemble grammar from independently translated
verbs and nouns. Plural forms follow i18next/`Intl.PluralRules`, including `many`
for the relevant French, Spanish and Portuguese counts. Chinese, Japanese and
Korean do not need an English singular form.

| Concept | 日本語 | 한국어 | Español | Deutsch | Français | Português (Brasil) |
| --- | --- | --- | --- | --- | --- | --- |
| Chapter | 章 | 장 | Capítulo | Kapitel | Chapitre | Capítulo |
| Act | 幕 | 막 | Acto | Akt | Acte | Ato |
| Note | メモ | 메모 | Nota | Notiz | Note | Nota |
| Idea | アイデア | 아이디어 | Idea | Idee | Idée | Ideia |
| Element | 要素 | 요소 | Elemento | Element | Élément | Elemento |
| Storyline | ストーリーライン | 스토리라인 | Trama | Handlungsstrang | Intrigue | Linha narrativa |

The seven additional catalogs are translated directly from the English resource
text and the product's terminology. No external translation service, local
translation model or character-conversion tool produces these translations.
Opaque interpolation values, links, markup and technical identifiers are
preserved. Automated checks verify completeness and behavior; they do not claim
exhaustive native-speaker proofreading.

## Acceptance and maintenance

```sh
pnpm locales:bootstrap
pnpm locales:evidence
pnpm locales:check
node scripts/run-interface-locales.mjs
node scripts/run-interface-locales.mjs --check
```

`docs/qa/interface-locales.json` is generated evidence: all nine app and reader
catalogs, normalized plural-key coverage, intact interpolation and representative
plural resolution, with source fingerprints. Existing intentionally empty source
labels remain empty; missing or accidentally emptied translations fail.

`src/shared/ui-locales.test.ts` checks regional/script matching, initial choice,
restricted storage and locale formatting. `multilingual.acceptance.test.ts`
checks the catalogs, Agent target preservation, plural counts and agreement
between the generated startup script and the renderer. Preference-sync tests
check accepted and unknown locale codes. Share-reader tests preserve opaque
names/emails and distinguish authentication errors.

`docs/qa/interface-locales-browser.json` is collected from the production React
controls and styles with synthetic text at 1280px and 800px. It covers all nine
settings choices, account-menu choices, fixed body portals, no horizontal page
overflow, immediate document language, unchanged synthetic text and saved choices
after a browser reload. Only unrelated project-settings preloading is stubbed.
It also measures the open account menu for every locale at all five interface
text sizes: 90 layouts across the two window widths. Labels must remain on one
line, selected values must fit, and the controls must not overlap. These checks
reproduce the former full-width dropdown squeezing the label to zero width.
Account-menu options are chosen with pointer events, verifying that the parent
menu remains open while interacting with its portalled language list.
Uncommitted visual samples include the open English and Brazilian Portuguese
account menus at standard and largest text sizes under `.qa/`.

For native DOM acceptance, start an isolated checkout profile:

```sh
pnpm drifting frontend serve --platform desktop --port 4329
pnpm dev:worktree --no-watch --frontend-debug
node scripts/run-native-interface-locales.mjs
```

Complete the first-run guide in this synthetic profile before collecting. The
collector refuses an app whose native name is not a worktree-test identity. It
opens the language settings route, uses the real picker, reloads WKWebView for
each locale, and checks the actual shelf account menu at all five text sizes
(45 layouts), including its nested language list. It restores the original choice.
The native report contains no
account, manuscript, credential or personal-path data. It records DOM input and
WebView reload, not physical pointer/keyboard acceptance or OS process restart.

This milestone covers interface localization and existing manuscript export
labels. It does not translate authored material, change the readable Markdown
archive's existing path/format contract, add spellcheck or claim RTL support.
Developer-only diagnostic panels and native/OS-provided messages keep their own
existing language behavior.
