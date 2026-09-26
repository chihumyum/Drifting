import UIKit

final class WorkspaceSearchViewController: UIViewController, UITableViewDataSource, UITableViewDelegate, UISearchBarDelegate {
    let model: WorkspaceSearchModel
    var onNavigate: ((WorkspaceSearchHit) -> Void)?
    var canNavigate: (() -> Bool)?
    private let searchBar = UISearchBar()
    private let tableView = UITableView(frame: .zero, style: .plain)
    private let status = UILabel()
    private var navigating = false

    init(model: WorkspaceSearchModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "项目搜索"
        view.backgroundColor = .systemBackground
        searchBar.placeholder = "搜索章节标题和正文"
        searchBar.searchTextField.accessibilityIdentifier = "search-query"
        searchBar.autocapitalizationType = .none
        searchBar.autocorrectionType = .no
        searchBar.delegate = self
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        status.numberOfLines = 0
        status.accessibilityIdentifier = "search-status"
        tableView.accessibilityIdentifier = "search-results"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "search-hit")
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 76
        tableView.dataSource = self
        tableView.delegate = self
        tableView.keyboardDismissMode = .onDrag
        let stack = UIStackView(arrangedSubviews: [searchBar, status, tableView])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])
        let close = UIBarButtonItem(title: "关闭", style: .done, target: self, action: #selector(closeSearch))
        close.accessibilityIdentifier = "close-search"
        navigationItem.rightBarButtonItem = close
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        searchBar.becomeFirstResponder()
    }

    private func reload() {
        status.text = model.status
        tableView.reloadData()
    }
    func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) { model.search(searchText) }
    func searchBarSearchButtonClicked(_ searchBar: UISearchBar) { searchBar.resignFirstResponder() }
    func numberOfSections(in tableView: UITableView) -> Int { model.unavailable.isEmpty ? 1 : 2 }
    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        section == 1 ? "未完成搜索的章节" : nil
    }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == 0 ? model.hits.count : model.unavailable.count
    }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "search-hit", for: indexPath)
        if indexPath.section == 1 {
            let unavailable = model.unavailable[indexPath.row]
            var content = cell.defaultContentConfiguration()
            content.text = unavailable.chapterTitle
            content.secondaryText = unavailable.message
            content.secondaryTextProperties.numberOfLines = 0
            content.textProperties.color = .secondaryLabel
            cell.contentConfiguration = content
            cell.accessibilityIdentifier = "search-unavailable-\(indexPath.row)"
            cell.accessibilityLabel = unavailable.chapterTitle + " · " + unavailable.message
            cell.accessoryType = .none
            cell.selectionStyle = .none
            return cell
        }
        let hit = model.hits[indexPath.row]
        let field = hit.kind == "title" ? "标题" : "正文"
        var content = cell.defaultContentConfiguration()
        content.text = hit.chapterTitle + " · " + field
        content.secondaryText = hit.preview
        content.secondaryTextProperties.numberOfLines = 3
        cell.contentConfiguration = content
        cell.accessibilityIdentifier = "project-search-hit-\(indexPath.row)"
        cell.accessibilityLabel = hit.chapterTitle + " · " + field + " · " + hit.preview
        cell.accessoryType = .disclosureIndicator
        cell.selectionStyle = .default
        return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard indexPath.section == 0, !navigating, !model.busy,
              model.hits.indices.contains(indexPath.row), canNavigate?() == true else { return }
        navigating = true
        onNavigate?(model.hits[indexPath.row])
    }
    @objc private func closeSearch() { dismiss(animated: true) }
}
