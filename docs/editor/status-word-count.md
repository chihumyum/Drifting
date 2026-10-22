# Footer word count

The footer's word count (`BottomStatusBar`, chosen by `deriveStatusWordMetric`)
follows the most specific context of the focused tab, in this order:

1. 选中: words in the editor selection.
2. 当前: the open chapter or drift — and in 通览全书, the chapter being edited.
3. 故事线: the open storyline's chapters.
4. 全书: every chapter.

In 通览全书 a chapter is "being edited" while keyboard focus is in its prose,
title or summary (`editingChapterIdFor`). `useWholeBookEditingChapter`
publishes that chapter per project; moving focus elsewhere — another control,
the page whitespace, another tab — returns the footer to 全书 after 200 ms,
which keeps a caret moving between chapters from flashing the book total.
Switching to another app keeps the chapter. The whole-book chapter only counts
while 通览全书 is the focused tab.

`status-word-metric.test.ts` covers the order and the whole-book cases;
`whole-book-editing.test.ts` covers which focus counts as editing. Focus
events in the running app are not covered by browser acceptance.
