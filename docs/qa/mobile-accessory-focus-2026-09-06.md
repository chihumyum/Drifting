# Mobile accessory activation and keyboard continuity — 2026-09-06

Fresh iOS Debug build on iPhone 17 Pro / iOS 26.5 Simulator, with the final
renderer changes loaded through the development server. Existing synthetic
harbour prose was used; its final document hash exactly matched the starting
hash. One synthetic conversation was removed and local provider/microphone
stubs were restored after acceptance. No provider request or recording occurred.

Fresh edit entry opens formatting. Existing accessory levels survive tool
returns, including a closed-to-open native keyboard transition. Undo and Redo
are independently visible only with a nonempty stack, in either editing level.

Native software-keyboard input followed by Undo, Redo and Undo verified both
content changes and keyboard continuity while the available history button
changed. Native taps covered Format/Back, Search and its result steps, Plot,
Timeline, Agent entry, configuration/model menus, history selection, microphone
start/stop, Send, Latest, accessory background and the explicit Back sequence.
Plot/Timeline preserve the editor's input session underneath their temporary
surface; Back restores its accessory. A Plot-owned input still dismisses first.

All accessory actions now share release-based activation. Native touch-end
focus behavior is cancelled before executing an action that may remove its
button; mouse compatibility events cannot activate it twice. Agent configuration
no longer autofocuses a menu button or restores focus to its trigger in the paper
accessory. Input fields retain their normal focus behavior.

The horizontal-pan regression used a renderer pointer/touch sequence, moving
away and back before release and a compatibility click. It scrolled the format
row 44px without changing prose, stored marks or history. The Simulator automation
drag emitted a tap without move events, so this is not a native finger-pan claim.
Gesture unit tests also cover jitter, distant release, pointer cancellation,
vertical movement and the next independent tap.

The adjacent JSON contains measured observations and computed assertions.
All six repository checks passed against the isolated commit candidate:
`ci:contract:check`, `public:check`, `lint`, `typecheck`, `test --maxWorkers=2`
and `agent:capabilities:check`. The full suite passed 2,060 tests with one skip;
lint reported 35 existing warnings and no errors. The measured JSON passed all
31 computed assertions.
