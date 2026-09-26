import XCTest

/// Uses the application's real project/chapter commands and editor. Each case
/// creates uniquely named synthetic content in the separate native workspace.
final class ProjectPersistenceUITests: XCTestCase {
    private func press(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: 15), file: file, line: line)
        #if os(macOS)
        element.click()
        #else
        element.tap()
        #endif
    }

    private func saved(_ app: XCUIApplication) {
        let status = app.staticTexts["document-status"]
        expectation(for: NSPredicate(format: "label == %@ OR value == %@", "正文已保存", "正文已保存"), evaluatedWith: status)
        waitForExpectations(timeout: 15)
    }

    private func equalText(_ app: XCUIApplication, _ value: String) {
        expectation(for: NSPredicate(format: "value == %@", value), evaluatedWith: app.textViews["document-text"])
        waitForExpectations(timeout: 15)
    }

    private func createProject(_ app: XCUIApplication, name: String) {
        press(app.buttons["create-project"])
        let field = app.textFields["new-project-name"]
        press(field)
        field.typeText(name)
        press(app.buttons.matching(identifier: "confirm-create-project").firstMatch)
        XCTAssertTrue(app.buttons["create-chapter"].waitForExistence(timeout: 15))
    }

    private func createChapter(_ app: XCUIApplication, title: String) {
        press(app.buttons["create-chapter"])
        let field = app.textFields["new-chapter-name"]
        press(field)
        field.typeText(title)
        press(app.buttons.matching(identifier: "confirm-create-chapter").firstMatch)
        currentChapter(app, title: title)
        saved(app)
    }

    private func rename(_ app: XCUIApplication, project: Bool, from oldName: String, to name: String) {
        let kind = project ? "project" : "chapter"
        press(app.buttons["rename-" + kind])
        let field = app.textFields["rename-" + kind + "-name"]
        press(field)
        XCTAssertEqual(field.value as? String, oldName)
        #if os(macOS)
        field.typeKey("a", modifierFlags: .command)
        #else
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: oldName.count))
        #endif
        field.typeText(name)
        press(app.buttons.matching(identifier: "confirm-rename-" + kind).firstMatch)
        let status = project ? "项目名称已保存" : "章节标题已保存"
        expectation(for: NSPredicate(format: "label == %@ OR value == %@", status, status),
                    evaluatedWith: app.staticTexts["workspace-status"])
        waitForExpectations(timeout: 15)
    }

    private func currentChapter(_ app: XCUIApplication, title: String) {
        expectation(for: NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", title, title),
                    evaluatedWith: app.staticTexts["current-chapter"])
        waitForExpectations(timeout: 15)
        XCTAssertTrue(app.textViews["document-text"].exists)
    }

    private func selectRow(_ app: XCUIApplication, title: String) {
        #if os(macOS)
        press(app.staticTexts[title].firstMatch)
        #else
        press(app.cells.matching(NSPredicate(format: "label == %@", title)).firstMatch)
        #endif
    }

    private func finishInput(_ app: XCUIApplication) {
        #if !os(macOS)
        press(app.buttons["finish-prose"])
        #endif
        saved(app)
    }

    func testCreateWriteUndoReopenAndProcessRestart() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let name = "Workspace " + UUID().uuidString.prefix(8)
        let chapter = "First chapter"
        let renamedProject = name + " renamed"
        let renamedChapter = "Renamed chapter"
        createProject(app, name: name)
        rename(app, project: true, from: name, to: renamedProject)
        createChapter(app, title: chapter)
        let prose = app.textViews["document-text"]
        let before = try XCTUnwrap(prose.value as? String)
        press(prose)
        prose.typeText("Native writing")
        finishInput(app)
        let after = try XCTUnwrap(prose.value as? String)
        XCTAssertTrue(after.contains("Native writing"))
        XCTAssertNotEqual(after, before)
        rename(app, project: false, from: chapter, to: renamedChapter)
        currentChapter(app, title: renamedChapter)
        equalText(app, after)
        press(app.buttons["undo-prose"]); saved(app)
        let undone = try XCTUnwrap(prose.value as? String)
        XCTAssertNotEqual(undone, after)
        press(app.buttons["redo-prose"]); saved(app); equalText(app, after)
        press(app.buttons["save-document"]); saved(app)
        press(app.buttons["reopen-document"])
        let reopened = "已从磁盘重新打开，正文自动保存"
        expectation(for: NSPredicate(format: "label == %@ OR value == %@", reopened, reopened),
                    evaluatedWith: app.staticTexts["workspace-status"])
        waitForExpectations(timeout: 15)
        saved(app); equalText(app, after)
        app.terminate()
        app.launch()
        selectRow(app, title: renamedProject)
        selectRow(app, title: renamedChapter)
        currentChapter(app, title: renamedChapter)
        saved(app); equalText(app, after)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Native writing workflow after process restart"
        attachment.lifetime = .keepAlways
        add(attachment)
        app.terminate()
    }

    func testChapterSwitchKeepsIndependentProse() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let name = "Two chapters " + UUID().uuidString.prefix(8)
        createProject(app, name: name)
        createChapter(app, title: "Chapter A")
        var prose = app.textViews["document-text"]
        press(prose); prose.typeText("Alpha prose"); finishInput(app)
        let first = try XCTUnwrap(prose.value as? String)
        #if !os(macOS)
        press(app.buttons["back-to-chapters"])
        #endif
        createChapter(app, title: "Chapter B")
        prose = app.textViews["document-text"]
        XCTAssertFalse((prose.value as? String ?? "").contains("Alpha prose"))
        press(prose); prose.typeText("Beta prose"); finishInput(app)
        let second = try XCTUnwrap(prose.value as? String)
        #if !os(macOS)
        press(app.buttons["back-to-chapters"])
        #endif
        selectRow(app, title: "Chapter A"); currentChapter(app, title: "Chapter A"); saved(app); equalText(app, first)
        #if !os(macOS)
        press(app.buttons["back-to-chapters"])
        #endif
        selectRow(app, title: "Chapter B"); currentChapter(app, title: "Chapter B"); saved(app); equalText(app, second)
        app.terminate()
    }
}
