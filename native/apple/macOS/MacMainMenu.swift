import AppKit

/// A menu key equivalent: the key AppKit matches (a lowercase letter, a
/// digit, punctuation or a function-key character) and its modifiers. An
/// empty key is no shortcut, which is how a command's default is removed.
struct MenuShortcut: Codable, Hashable {
    var key: String
    /// Canonical order: control, option, shift, command.
    var modifiers: [String]

    static let unassigned = MenuShortcut(key: "", flags: [])
    static let modifierNames: [(name: String, flag: NSEvent.ModifierFlags, symbol: String)] = [
        ("control", .control, "⌃"), ("option", .option, "⌥"), ("shift", .shift, "⇧"), ("command", .command, "⌘"),
    ]

    init(key: String, flags: NSEvent.ModifierFlags) {
        self.key = key.count == 1 && key.lowercased().count == 1 ? key.lowercased() : key
        modifiers = Self.modifierNames.filter { flags.contains($0.flag) }.map(\.name)
    }

    private enum CodingKeys: String, CodingKey { case key, modifiers }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let key = try values.decode(String.self, forKey: .key)
        let names = Set(try values.decodeIfPresent([String].self, forKey: .modifiers) ?? [])
        let flags = Self.modifierNames.filter { names.contains($0.name) }.map(\.flag)
        self.init(key: key, flags: NSEvent.ModifierFlags(flags))
    }

    var isNone: Bool { key.isEmpty }
    /// The key equivalent a menu item takes: a shifted letter is uppercase,
    /// the form AppKit matches against ⇧ presses (a lowercase letter with a
    /// shift mask would also answer the unshifted press).
    var menuKey: String {
        guard modifiers.contains("shift"), key.count == 1, key.uppercased() != key else { return key }
        return key.uppercased()
    }
    var flags: NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(Self.modifierNames.filter { modifiers.contains($0.name) }.map(\.flag))
    }

    /// As menus show it: “⇧⌘P”, “⌥⌘↑”, or 无.
    var display: String {
        guard !isNone else { return "无" }
        return Self.modifierNames.filter { modifiers.contains($0.name) }.map(\.symbol).joined() + Self.keyName(key)
    }

    static func keyName(_ key: String) -> String {
        guard let scalar = key.unicodeScalars.first, key.unicodeScalars.count == 1 else { return key.uppercased() }
        switch Int(scalar.value) {
        case NSUpArrowFunctionKey: return "↑"
        case NSDownArrowFunctionKey: return "↓"
        case NSLeftArrowFunctionKey: return "←"
        case NSRightArrowFunctionKey: return "→"
        case NSHomeFunctionKey: return "↖"
        case NSEndFunctionKey: return "↘"
        case NSPageUpFunctionKey: return "⇞"
        case NSPageDownFunctionKey: return "⇟"
        case NSDeleteFunctionKey: return "⌦"
        case NSF1FunctionKey...NSF35FunctionKey: return "F\(Int(scalar.value) - NSF1FunctionKey + 1)"
        case 0x0D, 0x03: return "↩"
        case 0x09, 0x19: return "⇥"
        case 0x20: return "空格"
        case 0x08, 0x7F: return "⌫"
        case 0x1B: return "⎋"
        default: return key.uppercased()
        }
    }

    /// The shortcut a key press names, or nil for a press without a key
    /// (a dead key or a modifier alone). Shift keeps letters lowercase with
    /// a shift modifier, as menus store them.
    static func recorded(from event: NSEvent) -> MenuShortcut? {
        let flags = event.modifierFlags.intersection([.command, .option, .control, .shift])
        guard let characters = event.charactersIgnoringModifiers, let first = characters.unicodeScalars.first else { return nil }
        var key = String(first)
        if Int(first.value) == 0x19 { key = "\t" } // ⇧⇥ reports a back-tab
        if Int(first.value) == 0x03 { key = "\r" } // the keypad Enter
        return MenuShortcut(key: key, flags: flags)
    }
}

/// Every command in the app's main menu, in menu order. The layout below
/// builds the menu AppDelegate installs; 设置 › 快捷键 lists the installed
/// menu's items by these identifiers. System commands keep their shortcuts.
enum MacMenuCommand: String, CaseIterable {
    case settings = "app.settings", quit = "app.quit"
    case save = "file.save", closeTab = "file.closeTab"
    case fileProfile = "file.projectProfile", fileDeleteProject = "file.deleteProject"
    case importFile = "file.import", exportBook = "file.exportBook", exportMarkdownFolder = "file.exportMarkdownFolder"
    case exportPDF = "file.exportPDF", pageSetup = "file.pageSetup", print = "file.print"
    case shelf = "project.shelf", projectTrash = "project.trash", projectProfile = "project.profile", projectDelete = "project.delete"
    case undo = "edit.undo", redo = "edit.redo", cut = "edit.cut", copy = "edit.copy", paste = "edit.paste", selectAll = "edit.selectAll"
    case find = "edit.find", findNext = "edit.findNext", findPrevious = "edit.findPrevious", findSelection = "edit.findSelection"
    case search = "edit.search", elements = "edit.elements", storylines = "edit.storylines", drifts = "edit.drifts"
    case relationTypes = "edit.relationTypes", addComment = "edit.addComment", comments = "edit.comments"
    case copilot = "edit.copilot", history = "edit.history"
    case bold = "format.bold", italic = "format.italic", underline = "format.underline", strike = "format.strike"
    case bodyText = "format.paragraph", heading1 = "format.heading1", heading2 = "format.heading2", heading3 = "format.heading3"
    case alignLeft = "format.alignLeft", alignCenter = "format.alignCenter", alignRight = "format.alignRight"
    case indentIncrease = "format.indentIncrease", indentDecrease = "format.indentDecrease"
    case link = "format.link", removeLink = "format.removeLink"
    case projectHome = "view.projectHome"
    case back = "view.back", forward = "view.forward", previousTab = "view.previousTab", nextTab = "view.nextTab"
    case agent = "view.agent", materials = "view.materials", review = "view.review", board = "view.board"
    case storyGraph = "view.storyGraph", wholeBook = "view.wholeBook", elementOverview = "view.elementOverview"
    case bottomTimeline = "view.bottomTimeline", plotPlanner = "view.plotPlanner", trash = "view.trash"
    case diagnostics = "help.diagnostics"

    var title: String {
        switch self {
        case .settings: return "设置…"
        case .quit: return "退出 Drifting Native Lab"
        case .save: return "保存正文"
        case .closeTab: return "关闭标签"
        case .fileProfile, .projectProfile: return "项目资料…"
        case .fileDeleteProject, .projectDelete: return "删除项目…"
        case .importFile: return "导入…"
        case .exportBook: return "导出全书…"
        case .exportMarkdownFolder: return "导出为 Markdown 文件夹…"
        case .exportPDF: return "导出 PDF…"
        case .pageSetup: return "页面设置…"
        case .print: return "打印…"
        case .shelf: return "项目书架…"
        case .projectTrash, .trash: return "回收站"
        case .undo: return "撤销"
        case .redo: return "重做"
        case .cut: return "剪切"
        case .copy: return "复制"
        case .paste: return "粘贴"
        case .selectAll: return "全选"
        case .find: return "查找…"
        case .findNext: return "查找下一个"
        case .findPrevious: return "查找上一个"
        case .findSelection: return "用所选内容查找"
        case .search: return "项目搜索"
        case .elements: return "设定库"
        case .storylines: return "故事线"
        case .drifts: return "漂流"
        case .relationTypes: return "关系类型…"
        case .addComment: return "添加批注…"
        case .comments: return "批注列表"
        case .copilot: return "Copilot 分析"
        case .history: return "历史版本…"
        case .bold: return "加粗"
        case .italic: return "斜体"
        case .underline: return "下划线"
        case .strike: return "删除线"
        case .bodyText: return "正文"
        case .heading1: return "标题 1"
        case .heading2: return "标题 2"
        case .heading3: return "标题 3"
        case .alignLeft: return "左对齐"
        case .alignCenter: return "居中"
        case .alignRight: return "右对齐"
        case .indentIncrease: return "增加缩进"
        case .indentDecrease: return "减少缩进"
        case .link: return "链接…"
        case .removeLink: return "移除链接"
        case .projectHome: return "项目主页"
        case .back: return "后退"
        case .forward: return "前进"
        case .previousTab: return "上一个标签"
        case .nextTab: return "下一个标签"
        case .agent: return "写作助手"
        case .materials: return "素材库"
        case .review: return "审阅"
        case .board: return "备忘与素材"
        case .storyGraph: return "故事图谱"
        case .wholeBook: return "全书长卷"
        case .elementOverview: return "设定总览"
        case .bottomTimeline: return "底部时间轴"
        case .plotPlanner: return "情节规划格"
        case .diagnostics: return "诊断摘要…"
        }
    }

    /// The shortcut the command has until the author changes it. ⇧⌘I is
    /// Copilot 分析 and ⌥⌘I 项目资料, as in the renderer; ⇧⌘P is the 项目书架,
    /// so 页面设置… starts without one. Find and alignment keep the macOS
    /// standard (⌘F, ⌘G, ⇧⌘G, ⌘E; ⌘{ ⌘| ⌘}), so 故事图谱 is ⌃⌘G; indent has
    /// Tab and ⇧Tab in the editor, leaving ⌘[ and ⌘] for 后退 and 前进;
    /// ⌥⌘← and ⌥⌘→ move between tabs and ⌘W closes the tab, as in Safari.
    var defaultShortcut: MenuShortcut {
        let command: NSEvent.ModifierFlags = .command, shift: NSEvent.ModifierFlags = [.command, .shift]
        let option: NSEvent.ModifierFlags = [.command, .option]
        switch self {
        case .settings: return MenuShortcut(key: ",", flags: command)
        case .quit: return MenuShortcut(key: "q", flags: command)
        case .save: return MenuShortcut(key: "s", flags: command)
        case .closeTab: return MenuShortcut(key: "w", flags: command)
        case .fileProfile: return MenuShortcut(key: "i", flags: option)
        case .importFile: return MenuShortcut(key: "o", flags: shift)
        case .print: return MenuShortcut(key: "p", flags: command)
        case .shelf: return MenuShortcut(key: "p", flags: shift)
        case .undo: return MenuShortcut(key: "z", flags: command)
        case .redo: return MenuShortcut(key: "z", flags: shift)
        case .cut: return MenuShortcut(key: "x", flags: command)
        case .copy: return MenuShortcut(key: "c", flags: command)
        case .paste: return MenuShortcut(key: "v", flags: command)
        case .selectAll: return MenuShortcut(key: "a", flags: command)
        case .find: return MenuShortcut(key: "f", flags: command)
        case .findNext: return MenuShortcut(key: "g", flags: command)
        case .findPrevious: return MenuShortcut(key: "g", flags: shift)
        case .findSelection: return MenuShortcut(key: "e", flags: command)
        case .search: return MenuShortcut(key: "f", flags: shift)
        case .elements: return MenuShortcut(key: "e", flags: shift)
        case .storylines: return MenuShortcut(key: "l", flags: shift)
        case .drifts: return MenuShortcut(key: "d", flags: shift)
        case .relationTypes: return MenuShortcut(key: "r", flags: shift)
        case .addComment: return MenuShortcut(key: "m", flags: option)
        case .copilot: return MenuShortcut(key: "i", flags: shift)
        case .history: return MenuShortcut(key: "y", flags: option)
        case .bold: return MenuShortcut(key: "b", flags: command)
        case .italic: return MenuShortcut(key: "i", flags: command)
        case .underline: return MenuShortcut(key: "u", flags: command)
        // ⌘{ ⌘| ⌘} are pressed with ⇧, and recorded that way.
        case .alignLeft: return MenuShortcut(key: "{", flags: shift)
        case .alignCenter: return MenuShortcut(key: "|", flags: shift)
        case .alignRight: return MenuShortcut(key: "}", flags: shift)
        case .link: return MenuShortcut(key: "k", flags: command)
        case .back: return MenuShortcut(key: "[", flags: command)
        case .forward: return MenuShortcut(key: "]", flags: command)
        case .previousTab: return MenuShortcut(key: arrowKey(NSLeftArrowFunctionKey), flags: option)
        case .nextTab: return MenuShortcut(key: arrowKey(NSRightArrowFunctionKey), flags: option)
        case .agent: return MenuShortcut(key: "a", flags: option)
        case .materials: return MenuShortcut(key: "m", flags: shift)
        case .review: return MenuShortcut(key: "r", flags: option)
        case .board: return MenuShortcut(key: "t", flags: option)
        case .storyGraph: return MenuShortcut(key: "g", flags: [.command, .control])
        case .wholeBook: return MenuShortcut(key: "b", flags: shift)
        case .elementOverview: return MenuShortcut(key: "e", flags: option)
        case .bottomTimeline: return MenuShortcut(key: "b", flags: option)
        case .plotPlanner: return MenuShortcut(key: "g", flags: option)
        default: return .unassigned
        }
    }

    private func arrowKey(_ key: Int) -> String { String(Character(UnicodeScalar(UInt32(key))!)) }

    /// The system's text-editing commands, 退出 and 关闭标签 (⌘W, which closes
    /// the window when no tab is open) keep their shortcuts.
    var isSystem: Bool { [.quit, .closeTab, .undo, .redo, .cut, .copy, .paste, .selectAll].contains(self) }

    /// Commands that act on the focused editor through the responder chain.
    var responderAction: Selector? {
        switch self {
        case .quit: return #selector(NSApplication.terminate(_:))
        case .undo: return #selector(ProseTextView.undo(_:))
        case .redo: return #selector(ProseTextView.redo(_:))
        case .cut: return #selector(NSText.cut(_:))
        case .copy: return #selector(NSText.copy(_:))
        case .paste: return #selector(NSText.paste(_:))
        case .selectAll: return #selector(NSText.selectAll(_:))
        case .addComment: return #selector(ProseTextView.addProseComment(_:))
        case .copilot: return #selector(ProseTextView.copilotAnalyze(_:))
        case .bold: return #selector(ProseTextView.boldProse(_:))
        case .italic: return #selector(ProseTextView.italicProse(_:))
        case .underline: return #selector(ProseTextView.underlineProse(_:))
        case .strike: return #selector(ProseTextView.strikeProse(_:))
        case .bodyText: return #selector(ProseTextView.bodyTextProse(_:))
        case .heading1: return #selector(ProseTextView.heading1Prose(_:))
        case .heading2: return #selector(ProseTextView.heading2Prose(_:))
        case .heading3: return #selector(ProseTextView.heading3Prose(_:))
        case .alignLeft: return #selector(ProseTextView.alignLeftProse(_:))
        case .alignCenter: return #selector(ProseTextView.alignCenterProse(_:))
        case .alignRight: return #selector(ProseTextView.alignRightProse(_:))
        case .indentIncrease: return #selector(ProseTextView.indentProse(_:))
        case .indentDecrease: return #selector(ProseTextView.outdentProse(_:))
        case .link: return #selector(ProseTextView.editProseLink(_:))
        case .removeLink: return #selector(ProseTextView.removeProseLink(_:))
        case .find, .findNext, .findPrevious, .findSelection: return #selector(NSResponder.performTextFinderAction(_:))
        default: return nil
        }
    }

    /// Find commands name their `NSTextFinder.Action` by tag, as AppKit's do.
    var tag: Int {
        switch self {
        case .find: return NSTextFinder.Action.showFindInterface.rawValue
        case .findNext: return NSTextFinder.Action.nextMatch.rawValue
        case .findPrevious: return NSTextFinder.Action.previousMatch.rawValue
        case .findSelection: return NSTextFinder.Action.setSearchString.rawValue
        default: return 0
        }
    }

    /// The editor format a 格式 command applies.
    var formatAction: NativeFormatAction? {
        switch self {
        case .bold: return .bold
        case .italic: return .italic
        case .underline: return .underline
        case .strike: return .strike
        case .bodyText: return .paragraph
        case .heading1: return .heading1
        case .heading2: return .heading2
        case .heading3: return .heading3
        case .alignLeft: return .alignLeft
        case .alignCenter: return .alignCenter
        case .alignRight: return .alignRight
        case .indentIncrease: return .indentIncrease
        case .indentDecrease: return .indentDecrease
        default: return nil
        }
    }

    var identifier: NSUserInterfaceItemIdentifier { NSUserInterfaceItemIdentifier("menu.\(rawValue)") }
    init?(identifier: NSUserInterfaceItemIdentifier?) {
        guard let raw = identifier?.rawValue, raw.hasPrefix("menu.") else { return nil }
        self.init(rawValue: String(raw.dropFirst(5)))
    }
}

/// The app's main menu: its layout and how it is built.
enum MacMainMenu {
    /// A target-action pair AppDelegate supplies for its own commands.
    struct Action {
        let selector: Selector
        weak var target: AnyObject?
        init(_ selector: Selector, _ target: AnyObject?) { self.selector = selector; self.target = target }
    }

    /// Menus in order; nil is a separator. The app menu's title is empty.
    static let layout: [(title: String, items: [MacMenuCommand?])] = [
        ("", [.settings, nil, .quit]),
        ("文件", [.save, .closeTab, nil, .fileProfile, .fileDeleteProject, nil, .importFile, .exportBook, .exportMarkdownFolder, .exportPDF,
                nil, .pageSetup, .print]),
        ("项目", [.shelf, .projectTrash, nil, .projectProfile, .projectDelete]),
        ("编辑", [.undo, .redo, .cut, .copy, .paste, .selectAll, nil, .find, .findNext, .findPrevious, .findSelection, nil,
                .search, .elements, .storylines, .drifts, .relationTypes, nil, .addComment, .comments, .copilot, nil, .history]),
        ("格式", [.bold, .italic, .underline, .strike, nil, .bodyText, .heading1, .heading2, .heading3, nil,
                .alignLeft, .alignCenter, .alignRight, nil, .indentIncrease, .indentDecrease, nil, .link, .removeLink]),
        ("视图", [.projectHome, nil, .back, .forward, .previousTab, .nextTab, nil, .agent, .materials, .review, .board, .storyGraph, .wholeBook, .elementOverview, nil, .bottomTimeline, .plotPlanner, nil,
                .trash]),
        ("帮助", [.diagnostics]),
    ]
    /// How 设置 › 快捷键 names the app menu.
    static let appMenuName = "应用"

    /// Builds the menu with every command's default shortcut; AppDelegate's
    /// commands take the given actions, editor commands go through the
    /// responder chain. A command without either stays disabled.
    static func build(_ actions: [MacMenuCommand: Action]) -> NSMenu {
        let menu = NSMenu()
        for (title, items) in layout {
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: title)
            for command in items {
                guard let command else { submenu.addItem(.separator()); continue }
                let item = NSMenuItem(title: command.title, action: actions[command]?.selector ?? command.responderAction,
                                      keyEquivalent: command.defaultShortcut.menuKey)
                item.keyEquivalentModifierMask = command.defaultShortcut.flags
                item.target = actions[command]?.target
                item.identifier = command.identifier
                item.tag = command.tag
                if command == .indentIncrease || command == .indentDecrease {
                    item.toolTip = command == .indentIncrease ? "在正文中也可按 Tab" : "在正文中也可按 ⇧Tab"
                }
                submenu.addItem(item)
            }
            top.submenu = submenu
            menu.addItem(top)
        }
        return menu
    }

    static func item(_ command: MacMenuCommand, in menu: NSMenu) -> NSMenuItem? {
        for top in menu.items {
            if let item = top.submenu?.items.first(where: { $0.identifier == command.identifier }) { return item }
        }
        return nil
    }

    static func submenu(_ title: String, in menu: NSMenu) -> NSMenu? {
        menu.items.first { $0.submenu?.title == title }?.submenu
    }

    /// The menu's commands grouped by menu, as installed: what 设置 › 快捷键 lists.
    static func groups(of menu: NSMenu) -> [(title: String, commands: [(command: MacMenuCommand, title: String)])] {
        menu.items.compactMap { top in
            guard let submenu = top.submenu else { return nil }
            let commands = submenu.items.compactMap { item in MacMenuCommand(identifier: item.identifier).map { ($0, item.title) } }
            guard !commands.isEmpty else { return nil }
            let title = submenu.title.isEmpty ? (top.title.isEmpty ? appMenuName : top.title) : submenu.title
            return (title, commands)
        }
    }

    /// “文件 › 打印…”: where a command lives in the layout.
    static func path(_ command: MacMenuCommand) -> String {
        let menu = layout.first { $0.items.contains(command) }?.title ?? ""
        return "\(menu.isEmpty ? appMenuName : menu) › \(command.title)"
    }
}

/// 设置 › 快捷键: the effective shortcut of every command, the rules a new
/// one must pass, and applying them to a menu. Overrides live in
/// `settings.json` (`shortcuts`); a command without one has its default.
enum MacShortcuts {
    /// Taken by macOS or by standard window and application commands.
    static let reserved: [(MenuShortcut, String)] = [
        (MenuShortcut(key: "q", flags: .command), "退出应用"),
        (MenuShortcut(key: "w", flags: .command), "关闭标签或窗口"),
        (MenuShortcut(key: "h", flags: .command), "隐藏应用"),
        (MenuShortcut(key: "h", flags: [.command, .option]), "隐藏其他应用"),
        (MenuShortcut(key: "m", flags: .command), "最小化窗口"),
        (MenuShortcut(key: "\t", flags: .command), "切换应用"),
        (MenuShortcut(key: "\t", flags: [.command, .shift]), "切换应用"),
        (MenuShortcut(key: "`", flags: .command), "切换窗口"),
        (MenuShortcut(key: "`", flags: [.command, .shift]), "切换窗口"),
        (MenuShortcut(key: " ", flags: .command), "聚焦搜索"),
        (MenuShortcut(key: " ", flags: [.command, .option]), "访达搜索"),
        (MenuShortcut(key: " ", flags: [.command, .control]), "表情与符号"),
        (MenuShortcut(key: "f", flags: [.command, .control]), "全屏幕"),
        (MenuShortcut(key: "q", flags: [.command, .control]), "锁定屏幕"),
        (MenuShortcut(key: "q", flags: [.command, .shift]), "退出登录"),
        (MenuShortcut(key: "\u{1b}", flags: [.command, .option]), "强制退出"),
        (MenuShortcut(key: "3", flags: [.command, .shift]), "截屏"),
        (MenuShortcut(key: "4", flags: [.command, .shift]), "截屏"),
        (MenuShortcut(key: "5", flags: [.command, .shift]), "截屏"),
        (MenuShortcut(key: "3", flags: [.command, .shift, .control]), "拷贝截屏"),
        (MenuShortcut(key: "4", flags: [.command, .shift, .control]), "拷贝截屏"),
        (MenuShortcut(key: "/", flags: [.command, .shift]), "帮助搜索"),
        (MenuShortcut(key: "?", flags: [.command, .shift]), "帮助搜索"),
        (MenuShortcut(key: ".", flags: .command), "取消"),
        (MenuShortcut(key: " ", flags: .control), "切换输入法"),
        (MenuShortcut(key: " ", flags: [.control, .option]), "切换输入法"),
        (MenuShortcut(key: arrow(NSUpArrowFunctionKey), flags: .control), "调度中心"),
        (MenuShortcut(key: arrow(NSDownArrowFunctionKey), flags: .control), "应用程序窗口"),
        (MenuShortcut(key: arrow(NSLeftArrowFunctionKey), flags: .control), "切换桌面空间"),
        (MenuShortcut(key: arrow(NSRightArrowFunctionKey), flags: .control), "切换桌面空间"),
    ]

    /// The prose editor's own bindings (NSTextView's standard key bindings):
    /// moving and selecting by line, word and document, deleting, and the
    /// Emacs control keys it honours.
    static let textEditing: [(MenuShortcut, String)] = {
        var bindings: [(MenuShortcut, String)] = []
        let arrows = [(NSUpArrowFunctionKey, "上"), (NSDownArrowFunctionKey, "下"), (NSLeftArrowFunctionKey, "左"), (NSRightArrowFunctionKey, "右")]
        for (flags, name) in [(NSEvent.ModifierFlags.command, "移到行首、行尾或文首、文末"), ([.command, .shift], "选到行首、行尾或文首、文末"),
                              (.option, "按词或段落移动"), ([.option, .shift], "按词或段落选择")] {
            for (key, _) in arrows { bindings.append((MenuShortcut(key: arrow(key), flags: flags), name)) }
        }
        bindings.append((MenuShortcut(key: "\u{7f}", flags: .command), "删除到行首"))
        bindings.append((MenuShortcut(key: "\u{7f}", flags: .option), "删除前一个词"))
        let emacs: [(String, String)] = [
            ("a", "移到段首"), ("e", "移到段尾"), ("k", "删除到段尾"), ("b", "左移一个字"), ("f", "右移一个字"), ("n", "移到下一行"),
            ("p", "移到上一行"), ("d", "删除后一个字"), ("h", "删除前一个字"), ("t", "交换前后两个字"), ("o", "在插入点后换行"),
            ("y", "粘贴删除的文字"), ("v", "向下翻页"),
        ]
        bindings += emacs.map { (MenuShortcut(key: $0.0, flags: .control), $0.1) }
        return bindings
    }()

    private static func arrow(_ key: Int) -> String { String(Character(UnicodeScalar(UInt32(key))!)) }

    /// A shifted digit or punctuation key arrives as the character it types
    /// with ⇧ (⇧⌘3 as “#”); reserved combinations are compared on the key
    /// itself too. The US layout's pairs, plus the key code when a press is
    /// at hand (digit keys whatever the layout).
    static func unshifted(_ shortcut: MenuShortcut, keyCode: UInt16? = nil) -> MenuShortcut? {
        guard shortcut.modifiers.contains("shift") else { return nil }
        let digitKeys: [UInt16: String] = [18: "1", 19: "2", 20: "3", 21: "4", 23: "5", 22: "6", 26: "7", 28: "8", 25: "9", 29: "0"]
        let pairs: [String: String] = ["!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
                                       "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".",
                                       "?": "/", "~": "`"]
        guard let base = keyCode.flatMap({ digitKeys[$0] }) ?? pairs[shortcut.key], base != shortcut.key else { return nil }
        return MenuShortcut(key: base, flags: shortcut.flags)
    }

    /// Every command's shortcut. System commands always keep their own; then
    /// the author's overrides take theirs, and only then does every other
    /// command take its default, unless an override already holds it: that
    /// command has none (a newer default never takes the author's shortcut
    /// away) and 设置 › 快捷键 names the holder (`defaultHolder`). An
    /// override the rules now refuse counts as none. An override two
    /// commands would share (only a hand-edited file can say so) stays with
    /// the first in menu order.
    static func effective(_ overrides: [String: MenuShortcut]) -> [MacMenuCommand: MenuShortcut] {
        var result: [MacMenuCommand: MenuShortcut] = [:]
        var taken = Set<MenuShortcut>()
        func take(_ command: MacMenuCommand, _ shortcut: MenuShortcut) {
            let free = !shortcut.isNone && !taken.contains(shortcut)
            if free { taken.insert(shortcut) }
            result[command] = free ? shortcut : .unassigned
        }
        let ordered = MacMainMenu.layout.flatMap { $0.items.compactMap { $0 } }
        for command in ordered where command.isSystem { take(command, command.defaultShortcut) }
        var defaults: [MacMenuCommand] = []
        for command in ordered where !command.isSystem {
            if let shortcut = overrides[command.rawValue], shortcut.isNone || refusal(shortcut) == nil {
                take(command, shortcut)
            } else {
                defaults.append(command)
            }
        }
        for command in defaults { take(command, command.defaultShortcut) }
        return result
    }

    /// The command holding `command`'s default shortcut when `command` has
    /// none because an override took it first; nil otherwise.
    static func defaultHolder(of command: MacMenuCommand, overrides: [String: MenuShortcut]) -> MacMenuCommand? {
        let target = command.defaultShortcut
        let current = effective(overrides)
        guard !command.isSystem, !target.isNone, current[command]?.isNone == true,
              overrides[command.rawValue].map({ !$0.isNone && refusal($0) != nil }) ?? true else { return nil }
        return MacMainMenu.layout.flatMap { $0.items.compactMap { $0 } }.first { $0 != command && current[$0] == target }
    }

    /// Why a shortcut cannot be used at all, whichever command asks: taken
    /// by macOS, used by the text editor, or without ⌘ or ⌃. `keyCode` is
    /// the recorded press's, when there is one.
    static func refusal(_ shortcut: MenuShortcut, keyCode: UInt16? = nil) -> String? {
        guard !shortcut.isNone else { return nil }
        let candidates = [shortcut] + [unshifted(shortcut, keyCode: keyCode)].compactMap { $0 }
        if let name = reserved.first(where: { candidates.contains($0.0) })?.1 {
            return "“\(shortcut.display)”由系统保留（\(name)），不能用于应用命令。"
        }
        if let name = textEditing.first(where: { $0.0 == shortcut })?.1 {
            return "“\(shortcut.display)”由文本编辑使用（\(name)），不能用于应用命令。"
        }
        let flags = shortcut.flags
        guard flags.contains(.command) || flags.contains(.control) else { return "快捷键需要包含 ⌘ 或 ⌃。" }
        return nil
    }

    /// Why `command` cannot take `shortcut` given the current overrides, or nil.
    static func refusal(_ shortcut: MenuShortcut, for command: MacMenuCommand, overrides: [String: MenuShortcut],
                        keyCode: UInt16? = nil) -> String? {
        if command.isSystem { return "“\(command.title)”是系统命令，快捷键不能更改。" }
        if let refusal = refusal(shortcut, keyCode: keyCode) { return refusal }
        guard !shortcut.isNone else { return nil }
        let current = effective(overrides)
        for other in MacMainMenu.layout.flatMap({ $0.items.compactMap { $0 } }) where other != command && current[other] == shortcut {
            if other.isSystem { return "“\(shortcut.display)”是系统的文本编辑快捷键（\(other.title)），不能占用。" }
            return "“\(shortcut.display)”已用于“\(MacMainMenu.path(other))”。请先为它换一个快捷键，或选择其他组合。"
        }
        return nil
    }

    /// Sets every identified item's key equivalent. Items of other menus
    /// and items without a command identifier are untouched.
    static func apply(_ overrides: [String: MenuShortcut], to menu: NSMenu) {
        let current = effective(overrides)
        for top in menu.items {
            for item in top.submenu?.items ?? [] {
                guard let command = MacMenuCommand(identifier: item.identifier), let shortcut = current[command] else { continue }
                if item.keyEquivalent != shortcut.menuKey { item.keyEquivalent = shortcut.menuKey }
                let flags = shortcut.isNone ? [] : shortcut.flags
                if item.keyEquivalentModifierMask != flags { item.keyEquivalentModifierMask = flags }
            }
        }
    }
}

/// Keeps a menu's key equivalents on the stored shortcuts: once when made
/// (at launch) and at once after every change in 设置 › 快捷键.
final class MacShortcutApplier {
    let store: LabSettingsStore
    let menu: NSMenu

    init(store: LabSettingsStore, menu: NSMenu) {
        self.store = store
        self.menu = menu
        MacShortcuts.apply(store.settings.shortcuts, to: menu)
        NotificationCenter.default.addObserver(self, selector: #selector(changed), name: LabSettingsStore.shortcutsDidChange, object: store)
    }
    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func changed() { MacShortcuts.apply(store.settings.shortcuts, to: menu) }
}
