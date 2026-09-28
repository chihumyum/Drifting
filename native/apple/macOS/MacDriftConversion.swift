import AppKit

/// The questions 转为章节… and 转为设定… ask before anything is written:
/// the new chapter's primary storyline (or none), or the new element's
/// category. Each is an alert with a popup of identities.
enum DriftConversionPicker {
    /// “无主线” first, then every live storyline; the first storyline is
    /// chosen when there is one.
    static func chapter(drift: WorkspaceDrift, storylines: [WorkspaceStoryline], actName: String?) -> (NSAlert, NSPopUpButton) {
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 280, height: 26), pullsDown: false)
        popup.addItem(withTitle: "无主线")
        popup.lastItem?.representedObject = ""
        popup.lastItem?.setAccessibilityIdentifier("convert-storyline-none")
        for storyline in storylines {
            popup.addItem(withTitle: storyline.name)
            popup.lastItem?.representedObject = storyline.id
            popup.lastItem?.setAccessibilityIdentifier("convert-storyline-\(storyline.id)")
        }
        if !storylines.isEmpty { popup.selectItem(at: 1) }
        popup.setAccessibilityIdentifier("convert-drift-storyline")
        popup.setAccessibilityLabel("主线")
        let alert = NSAlert()
        alert.messageText = "将漂流“\(drift.title)”转为章节？"
        var detail = "它会成为全书的最后一章，状态为草稿，正文、摘要和关系不变。选择它的主线，也可以不选。"
        if let actName { detail += "它是“\(actName)”的幕笔记，转换后这一绑定会解除。" }
        detail += "绑定它的时间标记会解除，并保留原来的名称。"
        alert.informativeText = detail
        alert.accessoryView = popup
        alert.addButton(withTitle: "转为章节").setAccessibilityIdentifier("confirm-convert-drift-chapter")
        alert.addButton(withTitle: "取消")
        return (alert, popup)
    }

    /// Every live category, the first chosen; nil when there is none.
    static func element(drift: WorkspaceDrift, categories: [WorkspaceElementCategory], actName: String?) -> (NSAlert, NSPopUpButton)? {
        guard !categories.isEmpty else { return nil }
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 280, height: 26), pullsDown: false)
        for category in categories {
            popup.addItem(withTitle: category.name)
            popup.lastItem?.representedObject = category.id
            popup.lastItem?.setAccessibilityIdentifier("convert-category-\(category.id)")
        }
        popup.setAccessibilityIdentifier("convert-drift-category")
        popup.setAccessibilityLabel("分类")
        let alert = NSAlert()
        alert.messageText = "将漂流“\(drift.title)”转为设定？"
        var detail = "会以漂流的标题、摘要和正文在所选分类中新建设定，然后把漂流移到回收站（可以恢复）。与已有设定同名时不会转换。"
        if let actName { detail += "它是“\(actName)”的幕笔记，移到回收站会解除这一绑定。" }
        alert.informativeText = detail
        alert.accessoryView = popup
        alert.addButton(withTitle: "转为设定").setAccessibilityIdentifier("confirm-convert-drift-element")
        alert.addButton(withTitle: "取消")
        return (alert, popup)
    }
}
