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
        var accessories: [UIView] = []
        if item.isChapter {
            let expanded = model.expanded.contains(item.entry.id)
            let button = UIButton(type: .system)
            button.setImage(UIImage(systemName: expanded ? "chevron.down" : "chevron.right"), for: .normal)
            button.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
            button.accessibilityIdentifier = "outline-expand-\(item.entry.id)"
            button.accessibilityLabel = "\(expanded ? "收起" : "展开") \(item.entry.title)"
            button.addAction(UIAction { [weak self] _ in self?.model.toggle(item.entry.id) }, for: .touchUpInside)
            accessories.append(button)
        }
        if item.isChapter || item.isAct { accessories.append(actions(for: item)) }
        if !accessories.isEmpty {
            let stack = UIStackView(arrangedSubviews: accessories)
            stack.frame = CGRect(x: 0, y: 0, width: accessories.count * 44, height: 44)
            stack.distribution = .fillEqually
            cell.accessoryView = stack
        }
        return cell
    }
    private func actions(for item: WorkspaceOutlineModel.Row) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(UIImage(systemName: "ellipsis.circle"), for: .normal)
        button.accessibilityIdentifier = "outline-actions-\(item.entry.id)"
        button.accessibilityLabel = "\(item.isAct ? "幕" : "章节")操作 \(item.entry.title)"
        button.isEnabled = !model.busy
        button.showsMenuAsPrimaryAction = true
        if item.isChapter {
            let create = UIAction(title: "在此开始一幕") { [weak self] _ in
                guard let self, self.canChangeBoundary() else { return }
                self.model.createAct(beforeChapterID: item.entry.id)
            }
            create.accessibilityIdentifier = "outline-create-act"
            button.menu = UIMenu(children: [create])
        } else {
            let rename = UIAction(title: "改名") { [weak self] _ in self?.renameAct(item.entry) }
            rename.accessibilityIdentifier = "outline-rename-act"
            let remove = UIAction(title: "移除分界（保留章节）", attributes: .destructive) { [weak self] _ in
                guard let self, self.canChangeBoundary() else { return }
                self.model.removeAct(id: item.entry.id)
            }
            remove.accessibilityIdentifier = "outline-remove-act"
            button.menu = UIMenu(children: [rename, remove])
        }
        return button
    }

    private func canChangeBoundary() -> Bool {
        guard !model.busy, canNavigate?() == true else {
            model.showStatus("请先完成输入，并等待正文保存后再修改幕分界。"); return false
        }
        return true
    }

    private func renameAct(_ entry: WorkspaceOutlineEntry) {
        guard canChangeBoundary() else { return }
        let alert = UIAlertController(title: "重命名幕", message: "只更改幕名称，章节和正文保持不变。", preferredStyle: .alert)
        alert.addTextField { field in
            field.text = entry.title
            field.accessibilityIdentifier = "rename-act-name"
            field.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        let save = UIAlertAction(title: "保存", style: .default) { [weak self, weak alert] _ in
            guard let self, self.canChangeBoundary() else { return }
            let name = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !name.isEmpty else { self.model.showStatus("幕名称不能为空，请重新输入。"); return }
            self.model.renameAct(id: entry.id, name: name)
        }
        save.accessibilityIdentifier = "confirm-rename-act"
        alert.addAction(save)
        present(alert, animated: true)
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let item = rows[indexPath.row]
        guard item.navigable, !model.busy, canNavigate?() == true else { return }
        onNavigate?(item.entry, item.heading?.blockId)
    }
    @objc private func closeOutline() { dismiss(animated: true) }
}
