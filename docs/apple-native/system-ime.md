# macOS system Pinyin observation

This standalone helper observes the real `NativeDocumentView`, macOS
input source and native key events. The default target is Apple's `SCIM.ITABC`;
`--input-source=<identifier>` selects another already-enabled Chinese input method.
The result records the actual provider and identifier. CUA performs every keystroke
and input-source change. The helper does not call `setMarkedText`, `insertText`,
TIS selection functions, event synthesis, paste or System Settings.
Its visible **Input Source** menu lists the editor context's existing input-source
IDs. A CUA click on a menu item sets only that window's
`NSTextInputContext.selectedKeyboardInputSource`; startup and cleanup never
select a source automatically. The same menu can restore the original source.

Prepare without launching a window:

```sh
node scripts/apple-system-ime-acceptance.mjs --prepare
# An existing enabled provider can be tested without installing or enabling another:
node scripts/apple-system-ime-acceptance.mjs --prepare --input-source=com.bytedance.inputmethod.doubaoime.pinyin
```

The local prepared manifest names an ad-hoc signed app and `phase.json`.
Launch that app with CUA, focus its editor, and follow the phase's `action`:
select the requested Pinyin source from the app's Input Source menu, position the caret with Command+Up when requested, press
`n`, `i`, `h`, `a`, `o` individually, select with Space,
then use Command+Z and Command+Shift+Z. Subsequent phases cover Escape
cancellation and another composition while a synthetic peer updates a different
paragraph. Do not use CUA text insertion or clipboard paste to simulate typing.
The observer checks marked text is absent from committed prose, Chinese commit,
one undo unit, redo, SQLite reopen, and retention of the remote text.

The final phase asks CUA to restore the original input source. The helper reads
TIS to verify restoration, writes its result and closes normally. A timeout or
unexpected input fails the attempt; do not turn a failed or incomplete run into
accepted evidence. All databases and runtime paths stay in ignored local output.
Only this app's synthetic editor and its input events are observed.

Collect the completed attempt without UI interaction:

```sh
node scripts/apple-system-ime-acceptance.mjs --collect --output=docs/apple-native/acceptance/p2b-system-ime.json
```

**Current status: failed attempt; system IME acceptance remains open.** The latest
Doubao Pinyin attempt observed the separate Command+Up positioning event, then
the five expected `nihao` keycodes with no modifiers. The target window and text
responder remained focused, and TIS reported
`com.bytedance.inputmethod.doubaoime.pinyin`. Nevertheless, `hasMarkedText` stayed
false and the marked range length was zero; the marked-text wait timed out.
Independent Yjs replay of this isolated synthetic database confirmed that Latin
`nihao` had been saved directly before the original fixture heading. The original
input source was restored. Earlier SCIM selection and positioning attempts are
retained locally and are not accepted runs.

The subsequent standard `NSApplication.run` attempt reproduced direct Latin input.
Its view and current input contexts matched, and both selected-source identifiers
agreed with TIS on Doubao Pinyin. A context mismatch or the earlier manual event
pump alone therefore does not explain that attempt. Read-only TIS mode-class and
ASCII-capability properties do not establish a provider's Chinese/English submode.
The subsequent Apple `SCIM.ITABC` run used the visible Input Source menu and
reproduced direct Latin input. The view/current contexts and TIS all reported
Apple Pinyin; the app was active, its editor focused, and all five keycodes had
zero modifiers. The marked range stayed empty and the composition wait timed out.
The collected `p2b-system-ime.json` records this failed attempt and successful
restoration of the original source.

An independent empty, unmodified `NSTextView` control then reproduced the same
failure with standard `NSApplication.run`, without Rust or the product binding.
CUA selected Apple Pinyin and sent the same positioning and five typing keys.
The app remained active and focused; TIS and both matching input contexts reported
`SCIM.ITABC`. All five typing keys had zero modifiers, but the view contained
exactly Latin `nihao`, with no marked text and a zero-length marked range. The
composition wait timed out, and the original source was restored. The raw and
collected control records match by SHA-256 and remain in ignored local output.
This narrows further diagnosis to the shared CUA/macOS input route: the symptom
also occurs without the product binding. It does not identify the exact mechanism
or demonstrate a failure with physical keyboard input. This diagnostic control
is not product acceptance. No assertion is relaxed to turn direct Latin input
into a composition pass.

A forwarding-only single-key probe now records the actual local event and text
client callback sequence in an empty `NSTextView`. With Apple Pinyin selected,
`n` reached `keyDown`, then `interpretKeyEvents`, then the one-argument
`insertText` and its two-argument implementation. The latter inserted one `n`;
the nested callbacks do not mean two characters were inserted. No
`setMarkedText` callback occurred, and short observations through approximately
0.6 seconds still found no marked range. The observed CGEvent representation
had an empty Unicode payload, keycode 45, keyboard type 91 and zero modifiers.
These event-source fields do not establish physical keyboard delivery or the
provider's Chinese/English submode.

Two runs with identical probe source reproduced that sequence: one selected
Pinyin from the helper's visible menu; the other used the macOS Control+Space
shortcut. In the latter, TIS and both text contexts changed from ABC to Pinyin
without a helper-menu selection. Thus the symptom also occurs through the
system shortcut, not only when the helper sets the context property. Both runs
restored ABC and exited normally. This does not yet distinguish synthesized-key
delivery, provider submode or another macOS input condition. Keep these
diagnostic observations separate from the failed product acceptance; do not
repeat the five-key timeout without a new variable to test.
The [redacted route comparison](acceptance/system-ime-routing-diagnostic.json)
was generated from both raw reports after checking source, executable,
configuration and report hashes. It preserves the ignored probe's historical
fingerprints, not a claim of execution against subsequently changed formal
sources. Runtime paths, process IDs and the installed-input-source list are
omitted. The retained local producer and review scripts are diagnostic artifacts;
this report does not replace `p2b-system-ime.json` or mark its failed gate passed.

Chinese marked text, Space candidate commit, system-IME undo/redo/reopen,
Escape cancellation and remote-during-composition phases were not reached.
Programmatic TextKit acceptance remains separate. Physical keyboard hardware,
background interruption, overlapping remote composition, iPhone/iPad input methods
and full P2 acceptance also remain open.
