import XCTest

final class ProjectPersistenceUITests: XCTestCase {
    #if !os(macOS)
    func testProseEditUndoRedoReopenAndRestart() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let prose = app.textViews["document-text"]
        XCTAssertTrue(prose.waitForExistence(timeout: 15))
        let status = app.staticTexts["document-status"]
        func saved() {
            expectation(for: NSPredicate(format: "label == %@", "正文已保存"), evaluatedWith: status)
            waitForExpectations(timeout: 15)
        }
        func equalText(_ text: String) {
            expectation(for: NSPredicate(format: "value == %@", text), evaluatedWith: prose)
            waitForExpectations(timeout: 15)
        }
        saved()
        let comments = app.staticTexts["document-comments"]
        XCTAssertTrue(comments.waitForExistence(timeout: 10))
        XCTAssertEqual(comments.label, "评论「北塔」· 已定位")
        let before = try XCTUnwrap(prose.value as? String)
        prose.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: 24, dy: 24)).tap()
        prose.typeText("Z")
        app.buttons["finish-prose"].tap()
        saved()
        let after = try XCTUnwrap(prose.value as? String)
        XCTAssertEqual(after.utf16.count, before.utf16.count + 1)
        app.buttons["undo-prose"].tap(); saved(); equalText(before)
        app.buttons["redo-prose"].tap(); saved(); equalText(after)
        prose.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: 24, dy: 24)).tap()
        prose.typeText("\n"); saved()
        let split = try XCTUnwrap(prose.value as? String)
        XCTAssertEqual(split.utf16.count, after.utf16.count + 1)
        app.buttons["undo-prose"].tap(); saved(); equalText(after)
        app.buttons["redo-prose"].tap(); saved(); equalText(split)
        prose.typeText(XCUIKeyboardKey.delete.rawValue); saved(); equalText(after)
        app.buttons["finish-prose"].tap()
        app.buttons["reopen-project"].tap(); saved(); equalText(after)
        app.terminate(); app.launch()
        XCTAssertTrue(prose.waitForExistence(timeout: 15)); saved(); equalText(after)
        XCTAssertEqual(comments.label, "评论「北塔」· 已定位")
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Native prose after process restart"
        attachment.lifetime = .keepAlways
        add(attachment)
        app.terminate()
    }
    #endif

    func testSaveReopenAndApplicationRestart() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let field = app.textFields["project-name"]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        let ready = NSPredicate(format: "enabled == true")
        expectation(for: ready, evaluatedWith: field)
        waitForExpectations(timeout: 15)
        let name = "Native acceptance " + UUID().uuidString.prefix(8)
        #if os(macOS)
        field.click()
        field.typeKey("a", modifierFlags: .command)
        #else
        field.tap()
        if field.buttons.firstMatch.exists { field.buttons.firstMatch.tap() }
        #endif
        field.typeText(name)
        XCTAssertEqual(field.value as? String, name)
        #if os(macOS)
        app.buttons["save-project"].click()
        #else
        app.buttons["save-project"].tap()
        #endif
        let status = app.staticTexts["project-status"]
        expectation(for: NSPredicate(format: "label == %@ OR value == %@", "已保存", "已保存"), evaluatedWith: status)
        waitForExpectations(timeout: 15)
        #if os(macOS)
        app.buttons["reopen-project"].click()
        #else
        app.buttons["reopen-project"].tap()
        #endif
        expectation(for: NSPredicate(format: "label == %@ OR value == %@", "已从磁盘重新打开", "已从磁盘重新打开"), evaluatedWith: status)
        waitForExpectations(timeout: 15)
        XCTAssertEqual(field.value as? String, name)
        app.terminate()
        app.launch()
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        expectation(for: NSPredicate(format: "value == %@", name), evaluatedWith: field)
        waitForExpectations(timeout: 15)
        #if !os(macOS)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Native project after process restart"
        attachment.lifetime = .keepAlways
        add(attachment)
        #endif
        app.terminate()
    }
}
