import UIKit

final class BookOutlineViewController: UITableViewController {
    let model: WorkspaceOutlineModel
    var onNavigate: ((WorkspaceOutlineEntry, String?) -> Void)?
    var canNavigate: (() -> Bool)?
    private var rows: [WorkspaceOutlineModel.Row] = []
    private let status = UILabel()

    init(model: WorkspaceOutlineModel) {
        self.model = model
        super.init(style: .plain)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "整书大纲"
        tableView.accessibilityIdentifier = "book-outline-list"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "outline")
        tableView.rowHeight = 52
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        status.textAlignment = .center
        status.accessibilityIdentifier = "outline-status"
        status.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: 64)
        tableView.tableHeaderView = status
        let close = UIBarButtonItem(title: "关闭", style: .done, target: self, action: #selector(closeOutline))
        close.accessibilityIdentifier = "close-outline"
        navigationItem.rightBarButtonItem = close
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }

    private func reload() {
        rows = model.rows
        status.text = model.status
        tableView.reloadData()
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let item = rows[indexPath.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "outline", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = item.label
        content.textProperties.numberOfLines = 1
        content.textProperties.color = item.navigable ? .label : .secondaryLabel
        if item.entry.kind == "act" { content.textProperties.font = .preferredFont(forTextStyle: .headline) }
        cell.contentConfiguration = content
        cell.indentationLevel = item.depth
        cell.indentationWidth = 14
        cell.accessibilityLabel = item.label
        cell.accessibilityIdentifier = item.identifier
        cell.selectionStyle = item.navigable ? .default : .none
        cell.accessoryView = nil
        if item.isChapter {
            let expanded = model.expanded.contains(item.entry.id)
            let button = UIButton(type: .system)
            button.setImage(UIImage(systemName: expanded ? "chevron.down" : "chevron.right"), for: .normal)
            button.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
            button.accessibilityIdentifier = "outline-expand-\(item.entry.id)"
            button.accessibilityLabel = "\(expanded ? "收起" : "展开") \(item.entry.title)"
            button.addAction(UIAction { [weak self] _ in self?.model.toggle(item.entry.id) }, for: .touchUpInside)
            cell.accessoryView = button
        }
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let item = rows[indexPath.row]
        guard item.navigable, canNavigate?() == true else { return }
        onNavigate?(item.entry, item.heading?.blockId)
    }
    @objc private func closeOutline() { dismiss(animated: true) }
}
