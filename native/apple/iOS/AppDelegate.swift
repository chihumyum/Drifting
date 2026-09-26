import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Native Lab", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UINavigationController(rootViewController: ProjectViewController())
        self.window = window
        window.makeKeyAndVisible()
    }
}

final class ProjectViewController: UIViewController {
    private let core = LabCore()
    private lazy var documentView = NativeDocumentView(core: core)
    private let nameField = UITextField()
    private let status = UILabel()
    private let saveButton = UIButton(type: .system)
    private let reopenButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "原生写作实验"
        view.backgroundColor = .systemBackground
        let subtitle = UILabel()
        subtitle.text = "这里使用独立的合成项目。你的日常写作资料不会在这里打开。"
        subtitle.numberOfLines = 0
        subtitle.textColor = .secondaryLabel
        subtitle.font = .preferredFont(forTextStyle: .footnote)
        subtitle.adjustsFontForContentSizeCategory = true
        nameField.borderStyle = .roundedRect
        nameField.clearButtonMode = .whileEditing
        nameField.placeholder = "项目名称"
        nameField.font = .preferredFont(forTextStyle: .title3)
        nameField.adjustsFontForContentSizeCategory = true
        nameField.accessibilityIdentifier = "project-name"
        saveButton.setTitle("保存名称", for: .normal)
        saveButton.accessibilityIdentifier = "save-project"
        saveButton.addTarget(self, action: #selector(save), for: .touchUpInside)
        reopenButton.setTitle("重新打开", for: .normal)
        reopenButton.accessibilityIdentifier = "reopen-project"
        reopenButton.addTarget(self, action: #selector(reopen), for: .touchUpInside)
        status.textColor = .secondaryLabel
        status.numberOfLines = 0
        status.accessibilityIdentifier = "project-status"
        let actions = UIStackView(arrangedSubviews: [saveButton, reopenButton])
        actions.distribution = .fillEqually
        let stack = UIStackView(arrangedSubviews: [subtitle, nameField, actions, status, documentView])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -12),
            nameField.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            saveButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            reopenButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
        documentView.onActivity = { [weak self] busy in self?.reopenButton.isEnabled = !busy }
        busy(true)
        core.open { [weak self] result in
            self?.receive(result, message: "项目已打开")
            if case .success = result { self?.documentView.binding.load() }
        }
    }
    private func busy(_ value: Bool) {
        nameField.isEnabled = !value
        saveButton.isEnabled = !value
        reopenButton.isEnabled = !value
    }
    private func receive(_ result: Result<LabState, Error>, message: String) {
        busy(false)
        switch result {
        case .success(let state): nameField.text = state.name; status.text = message
        case .failure(let error): status.text = error.localizedDescription
        }
    }
    @objc private func save() {
        view.endEditing(true)
        busy(true)
        core.rename(nameField.text ?? "") { [weak self] in self?.receive($0, message: "已保存") }
    }
    @objc private func reopen() {
        view.endEditing(true)
        guard !documentView.binding.hasPendingWork else { return }
        busy(true)
        core.reopen { [weak self] result in
            self?.receive(result, message: "已从磁盘重新打开")
            if case .success = result { self?.documentView.binding.load() }
        }
    }
}
