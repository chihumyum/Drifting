# 项目模板格式规格（`drifting.project-template` 版本 1）

2026-11-15 由 PT1（`handoff/v5-tracks.md`（2026-11-18 删了，最后一版 `git show 64563601b:docs/rust-rewrite/handoff/v5-tracks.md`；还要做的在 `handoff/v5-followups.md`（2026-11-25 删了，最后一版 `git show 9cf3d2c7d:docs/rust-rewrite/handoff/v5-followups.md`））「PT1 项目模板的数据」）随书目格式 5（[kernel-v5.md](kernel-v5.md)）定稿。设计背景、产品边界与两期分工见 [project-templates.md](project-templates.md)；本页是模板值（`ProjectTemplateValue`）与唯一校验器（`dr_model::project_template`）逐字段的正式规格。

- 类型与唯一校验器：`next/crates/dr-model/src/project_template/`（`ProjectTemplateValue`、`parse_project_template_json`、`validate_project_template_value`、`to_canonical_json`）。
- 书库模板文档、从项目提取与展开建书：`next/crates/dr-doc/src/project_template.rs`。
- 工作区命令与统一 `project.create`：`next/crates/dr-workspace/src/commands/v3/project_template.rs`、`novel_book.rs`。

**2026-11-15 夜里改了两处**（作者在项目模板界面的原型上定的，kernel-v5 第 15 节第 27 条）：成书没有起点了，`project.book` 去掉 `root`；导出署名用账号名、不要主页，`credit` 去掉 `homepage`。格式还没发布，直接改，不留兼容：`formatVersion` 仍是 `1`，结构是封闭的，带这两个键的模板拒收。代码在任务书 DW 一步里跟着改了（`dr-model/tests/project_template.rs` 的 `a_book_start_a_homepage_or_derived_from_is_refused`）。

**2026-11-24 加了自定义模块**（[custom-modules.md](custom-modules.md) 第 11 节，任务书 CM1，结论在 [modules/m44-custom-modules.md](modules/m44-custom-modules.md)）：模板值多一个 `modules`（第 3 节），模块种类多一种 `custom`，配置多一个 `module`（第 5 节）。格式还没发布，照旧直接改：`formatVersion` 仍是 `1`。

**同一夜补问又改了两处**（kernel-v5 第 15 节第 28 条）：「改自」整个去掉，`credit` 只剩 `author`，取导出的人的账号显示名；编辑模板的工作区随改随存，没有保存和放弃（第 11 节）。照样直接改、不留兼容，带 `derivedFrom` 的模板拒收。代码在任务书 DW 里一起改了（监管会话 2026-11-16 把它从 PT2 挪进 DW）。

## 1. 总则与封闭结构

项目模板是从项目当前状态提取出来的一份**无历史、无个人与设备标识、封闭结构**的纯数据值。书库里 `project-template:<id>` 的 `payload.record` 里的 `value`、导出的 `.driftingtemplate` 文本文件、社区仓库里的模板文件，以及 `project.create` 接收的完整模板值，都是同一份结构，过同一个校验器。

1. **结构封闭（与书目文档相反）**：书目文档遵循 `UNKNOWN-KEPT` 保留未知字段和未知枚举串；项目模板的所有结构体一律开启 `deny_unknown_fields`，所有枚举只接受本规格列出的已知取值。出现未知键、未知模块种类、未知字段类型、未知摆法或未知标记键一律拒收（`ProjectTemplateError::MalformedJson`）。
2. **先验大小与版本头，再走封闭反序列化**：`parse_project_template_json` 按固定顺序检查：
   - UTF-8 字节长度超过上限先报 `TooLarge`；
   - 先读 `(format, formatVersion)` 头：`format` 不是 `"drifting.project-template"` 报 `InvalidFormat`；`formatVersion > 1` 报 `UnsupportedFormatVersion { found, supported: 1 }`（即使未来版本新增了本版不认识的字段，旧客户端也稳定给出「模板格式版本更新」而不是「未知字段」）；`formatVersion <= 0` 报 `InvalidFormatVersion`；
   - 再做封闭结构反序列化与完整语义校验 `validate_project_template_value`。
3. **规范化序列化（`to_canonical_json`）**：UTF-8 编码、2 空格缩进、末尾单个 `\n`；对象键按结构体声明顺序与 `BTreeMap` 字典序固定排列，默认空值按本规格省略，同一份模板值重复导出逐字节相同。
4. **硬上限**：

| 上限项 | 常量 | 数值 | 说明 |
| --- | --- | --- | --- |
| 序列化体积 | `MAX_PROJECT_TEMPLATE_BYTES` | `2,097,152`（2 MiB） | 原始输入字节数与规范化写出字节数均不得超过 |
| 条目模板数 | `MAX_PROJECT_TEMPLATE_TEMPLATES` | `200` | `templates` 数组长度上限 |
| 起始／示例条目数 | `MAX_PROJECT_TEMPLATE_ENTRIES` | `2,000` | `entries` 数组长度上限 |
| 帮手说明总字数 | `MAX_PROJECT_TEMPLATE_AGENT_CHARS` | `100,000` | 按 Unicode 标量计，累计 `project.agent.{name, description, instructions}`、`templates[].agent.{name, description, instructions}`、`templates[].modules[].agent.instructions`、`templates[].verbs[].{name, description}` |

## 2. 代号与标识符规则

- **条目代号（`e1`、`e2`、…）**：以小写 `e` 开头，后接 1–6 位十进制数字且首位不为 `0`（`is_symbolic_entry_ref`）。在 `entries[].ref` 中唯一；真实 UUID、书 id、文件 id 均不合法。
- **视图代号（`v1`、`v2`、…）**：以小写 `v` 开头，后接 1–6 位十进制数字且首位不为 `0`（`is_symbolic_view_ref`）。在 `views[].ref` 中唯一。
- **项目内标识符（原样保留）**：条目模板 `id`（如 `tpl-chapter`）、模块 `id`（如 `mod-prose`）、字段 `id`、动作 `id` 沿用项目内部名字，须满足 `check_id`（非空、不超过 256 字节、不含控制字符；条目模板 `id` 与模块 `id` 还不得含 `/` 或 `|`）。新建项目时不改写这些内部标识符。
- **顺序由数组先后决定**：`project.tabs`、`templates[].modules`、`templates[].modules[].config.defs`、`initial_kv`、`templates[].verbs`、`entries`（先序遍历，同一 `parent` 下的先后即兄弟手动顺序）、`memberships`（同一 `host` 下的成员先后）、`views`、`views[].lanes` 均不存分数索引 `pos`；展开建书时按数组顺序重新生成 `PosKey`。

## 3. 顶层对象（`ProjectTemplateValue`）

| 字段 | JSON 键 | 类型 | 必填／默认 | 校验规则 |
| --- | --- | --- | --- | --- |
| `format` | `format` | `string` | 必填 | 固定为 `"drifting.project-template"` |
| `format_version` | `formatVersion` | `i64` | 必填 | 当前固定为 `1` |
| `made_with` | `madeWith` | `string` | 默认 `""` | 单行文本，不含控制字符（生成端记录客户端版本，可空） |
| `name` | `name` | `string` | 必填 | 去首尾空白后非空，不含控制字符 |
| `description` | `description` | `string` | 默认 `""` | 可多行（允许 `\n`、`\r`、`\t`，禁其余控制字符） |
| `locale` | `locale` | `string` | 默认 `""` | 单行语言标签（如 `"zh-Hans"`），不含控制字符 |
| `revision` | `revision` | `i64` | 必填 | `>= 1`；替换已有模板重存时递增 |
| `credit` | `credit` | `ProjectTemplateCredit?` | 可选，空时省略 | 见下表 |
| `project` | `project` | `TemplateProject` | 必填 | 项目定义（不含 `source`），见第 4 节 |
| `templates` | `templates` | `TemplateEntryTemplate[]` | 默认 `[]` | 条目模板列表，`id` 不重复，最多 200 项，见第 5 节 |
| `relation_types` | `relation_types` | `TemplateRelationType[]` | 默认 `[]` | 作者自建关系类型（不含系统内置通用关联），见第 6 节 |
| `entries` | `entries` | `TemplateEntry[]` | 默认 `[]` | 骨架与示例条目，最多 2,000 项，见第 7 节 |
| `memberships` | `memberships` | `TemplateMembership[]` | 默认 `[]` | 挂名归属与主归属，见第 8 节 |
| `views` | `views` | `TemplateView[]` | 默认 `[]` | 视图、泳道、刻度位置与时间钉，见第 9 节 |
| `template_prose` | `template_prose` | `Map<string, TemplateParagraph[]>` | 默认 `{}` | 键为 `"<条目模板 id>/<模块 id>"`，目标须是 `templates` 中存在的 `prose` 模块；段落规格见第 10 节 |
| `modules` | `modules` | `Map<string, ModuleValue>` | 默认 `{}`，空时省略 | 条目模板里 `custom` 模块用到的自定义模块，整份带上（2026-11-24 加）。键是模块 id（合法 `CustomModuleId`：非空、不超过 256 字节、无控制字符、无 `/` 和 `|`）；值是一份 `drifting.module` 模块，过模块的封闭校验器（[custom-modules.md](custom-modules.md) 第 6、12 节）；每个键都必须有 `custom` 模块用着，没人用的拒收 |

### `credit`（署名）

| JSON 键 | 类型 | 校验规则 |
| --- | --- | --- |
| `author` | `string`（空串省略） | 单行文本，不含控制字符。导出成文件时取导出的人的账号显示名：导出别人做的模板也一样，不提原作者；账号没设名字或没登录就不写，不用邮箱 @ 前面那段（2026-11-15 夜里定，PT2 做）。另存时只用调用方给的，不从项目的来源自动填 |

`credit` 只有这一个键。原来还有 `homepage`（只收 `https` 链接），2026-11-15 夜里去掉（作者：「主页，暂时不需要这个东西。以后再说社交。」）；还有 `derivedFrom`（`{ name, author? }`，从来源为 `file` 或 `community` 的项目另存时自动填入上游模板名与作者），同一夜作者在补问里选了「改自」整个去掉。项目定义里 `project.source.credit` 也只剩 `author`，书里旧的 `homepage`、`derived_from` 读的时候不管。

## 4. 项目定义（`project`）

对齐格式 5 书目的 `project` 根（[kernel-v5.md](kernel-v5.md) 第 2、10 节），去掉只属于实例书的 `source` 与 Tab 的 `id`／`pos`：

- `agent`（可选 `{ name, description, instructions }`）：整本项目的帮手说明；`name` 不含控制字符，`description`／`instructions` 允许换行与制表符。
- `book`（可选 `TemplateProjectBook`）：
  - **缺键或 `null`**：项目关闭「成书」（`project.book == None`）。
  - **存在对象**：项目开启「成书」，成书从根读（[kernel-v5.md](kernel-v5.md) 第 3 节）：
    - `word_target`、`daily_word_target`（可选 `i64`）：存在时须 `>= 1`（`0` 在提取时规范化为缺省 `None`）。
    - 没有别的键。原来的 `root`（成书起点，`root`／`entry`／`view`／`lane` 四种）2026-11-15 夜里去掉，带着它的模板拒收。
- `tabs`（`TemplateTab[]`，默认 `[]`）：左栏自定义 Tab，数组先后即显示先后。Tab 没有自己的名字，叫它挂的东西的名字；同一样东西只挂一个 Tab，重复的挂载校验不过（作者 2026-11-15，[kernel-v5.md](kernel-v5.md) 第 5 节；原来有 `name`，`mount` 也可以缺）。另存时目标已缺失的 Tab 不导出，项目里挂视图的 Tab（书里存着的旧 Tab）也不导出（2026-11-16 DV）。没有挂根的 Tab 时，建书时补上「全部」：
  - `mount`（必填 `TemplateTabMount`）：
    - `{"kind": "root"}`：挂最外层；
    - `{"kind": "entry", "entry": "e…"}`：目标条目须存在且满足 `has_below`；
    - ~~`{"kind": "view", "view": "v…"}`：目标视图须存在。~~ **2026-11-16 DV 去掉**：作者定了左栏的 Tab 不能挂视图（「左栏不能挂视图，视图和底栏是绑定的。」[kernel-v5.md](kernel-v5.md) 第 15 节第 15 条）。格式没发布，直接改，`formatVersion` 仍是 1：`TemplateTabMount` 没有 `view` 一种，带它的模板值按不认识的取值拒收（`MalformedJson`）；
    - `{"kind": "book"}`：挂成书序列，仅当 `project.book` 存在（开启成书）时合法。

## 5. 条目模板（`templates[]`）

对齐格式 5 的 `EntryTemplate`（拆开「层级」与「收别处的条目」，去掉 `lane`、`kind`、`allow`；见 [kernel-v5.md](kernel-v5.md) 第 16 节）：

| JSON 键 | 类型 | 默认 | 校验规则 |
| --- | --- | --- | --- |
| `id` | `string` | 必填 | 合法 `EntryTemplateId`，在 `templates` 内唯一 |
| `name` | `string` | 必填 | 去首尾空白后非空，不含控制字符 |
| `mark` | `string?` | `null` | 存在时须通过 `is_valid_mark`（已知砂笔图标名或单个非空白字符） |
| `color` | `string?` | `null` | 单行颜色串，不含控制字符 |
| `agent` | `TemplateAgent?` | `null` | 条目模板级帮手说明 |
| `modules` | `TemplateModuleSpec[]` | `[]` | 模块 `id` 在同一条目模板内唯一 |
| `level` | `bool` | `false` | 用此模板新建条目时「层级」开关的初值 |
| `linkable` | `bool` | `true` | 用这种模板新建的条目跟不跟所在层「自动链接」的默认、按层一起打开时带不带上它（2026-11-24 起只管这两样，不再否决链接；`kernel-v5.md` 第 16 节） |
| `settings` | `TemplateLevelSettings` | `{}` | 见下表（无 `lane`） |
| `verbs` | `TemplateVerbSpec[]` | `[]` | 动作 `id` 在同一条目模板内唯一；`name` 非空；`target_template` 存在时须指 `templates` 中的模板 |

### 「下面」与挂名设置（`TemplateLevelSettings`：用于 `templates[].settings` 与 `entries[].overrides`）

| JSON 键 | 取值 | 继承与校验规则 |
| --- | --- | --- |
| `default_template` | 缺键 ／ `null` ／ `"<条目模板 id>"` | 三态：缺键表示不覆盖（沿住处祖先继承）；显式 `null` 表示清空默认模板；字符串须存在于 `templates` |
| `display` | `"list"` \| `"grid"` \| `"board"` \| `"island"` | 沿住处祖先继承 |
| `auto_link` | `bool` | 这一层「自动链接」的默认：在下面新建的条目照最近的、设过值的那一层开或关（只看住处父链，不看挂名）。条目自己的开关不在这里，在条目的 `auto_link`（第 7 节） |
| `accept` | `bool` | 「收别处的条目」开关，只读条目自身 `overrides.accept` 与自身模板 `settings.accept`，不沿树继承 |
| `home` | 缺键 ／ `null` ／ `"e…"` | 「新条目住在」，不沿树继承；三态：缺键不覆盖、显式 `null` 表示落最外层、`"e…"` 须指向 `entries` 中 `level == true` 的条目 |
| `format_shortcuts` | `"full"` \| `"notes"` \| `"plain"` | 沿住处祖先继承 |

### 模块定义（`TemplateModuleSpec` 与 `TemplateModuleConfig`）

- `id`：合法 `ModuleId`；`name`：非空单行文本；`kind`：封闭枚举 `"prose"` \| `"fields"` \| `"kv"` \| `"patches"` \| `"plot_grid"` \| `"children"` \| `"members"` \| `"media"` \| `"custom"`（2026-11-24 加）。
- `agent`（可选）：`{ writable: bool (默认 true), read_tier?: string, instructions: string }`。
- `config`：
  - `show_outline`（`bool`，默认 `false`）、`task_todos`（`bool`，默认 `false`）、`in_book`（`bool`，默认 `true`）；
  - `defs`（`TemplateFieldDef[]`，仅 `kind == "fields"` 时允许非空）：字段 `id` 在模块内唯一，`name` 非空，`field_type` 为封闭枚举 `"text"` \| `"long_text"` \| `"number"` \| `"date"` \| `"select"` \| `"multi_select"` \| `"image"` \| `"entity_ref"` \| `"aliases"` \| `"toggle"`：
    - `options`：`select`／`multi_select` 的选项列表，项非空且互不重复；非选项型字段须为空；
    - `target_template`：仅 `entity_ref` 可设，须存在于 `templates`；
    - `default_value`：类型须与 `field_type` 匹配（`date` 为合法 `YYYY-MM-DD`，`number` 为有限实数，`select`／`multi_select` 落在 `options` 内，`entity_ref` 为代号 `"e…"` 且目标条目满足 `target_template`；**第一期不带文件，`image` 字段不得带非空 `default_value`**）；
  - 字段角色 `aliases_field`、`color_field`、`status_field`、`summary_field`、`portrait_field`：有值时须指向本模块 `defs` 中已定义的字段 `id`；
  - `initial_kv`（`TemplateKvRow[]`，仅 `kind == "kv"` 允许非空）：`{ key, value }`，`key` 去空白后非空；
  - `default_rows`、`default_cols`（`u32`，默认 `3`）：须 `>= 1`；
  - `arrangement`（可选 `"featured"` \| `"grid"` \| `"list"`）：仅 `kind == "media"` 允许设置；
  - `module`（可选字符串，2026-11-24 加）：`kind == "custom"` 时必填，须是顶层 `modules` 的一个键；别的种类不得有。`custom` 模块的 `in_book` 必须是 `false`（自定义模块不进成书，custom-modules.md 第 16 节第 2 条）。示例条目（第 7 节）**不带**自定义模块的值：另存时不取，新建项目时也没有（设计稿没说到，按最保守的做，等作者定）。

## 6. 自定义关系类型（`relation_types[]`）

`relation_types` 保存项目里定义的关系。展开时为每种定义生成新的 `RelationTypeId`，初始没有行。

- `name` 是非空单行文本，按 `normalize_relation_type_name` 归一化后唯一。
- `description` 是 `{ text, links: [{ start, end, entry, manual? }] }`，省略时为空；`manual: true` 是 @ 挑出来的链接（2026-11-24，`kernel-v5.md` 第 16 节），不受「自动链接」开关管，缺省是自动的。区间使用 Unicode 标量下标，左闭右开，按起点递增且不重叠。`entry` 是模板内存在的 `e…` 代号。另存时保留指向未选条目的链接原字。展开已选条目的链接时换成新 id。
- `direction` 取 `"directed"` 或 `"symmetric"`。

## 7. 条目（`entries[]`）

| JSON 键 | 类型 | 默认 | 校验规则 |
| --- | --- | --- | --- |
| `ref` | `string` | 必填 | 合法代号 `"e…"`，全表唯一 |
| `parent` | `string?` | `null` | `null` 为顶层；非空时须指向 `entries` 中 `level == true` 的另一条目，整片森林无环 |
| `title` | `string` | 必填 | 去首尾空白后非空，不含控制字符 |
| `template` | `string?` | `null` | 非空时须存在于 `templates` |
| `level` | `bool` | `false` | 条目自身的「层级」开关 |
| `overrides` | `TemplateLevelSettings?` | `null` | 条目自身的设置覆盖 |
| `auto_link` | `bool?` | 缺键 | 条目自己的「自动链接」（2026-11-24 AB）：另存时照书里的写；展开时写了的照写的，缺键的照所在层的默认算（模板 `linkable`，且住的那一层默认开）。内置写书模板不写 |
| `mark` | `string?` | `null` | 存在时须通过 `is_valid_mark` |
| `fields` | `Map<ModuleId, Map<FieldId, FieldValue>>` | `{}` | 模块须是该条目当前模板上的 `fields` 模块，字段须在 `defs` 中定义且值类型匹配；`entity_ref` 存代号 `"e…"`；第一期 `image` 字段不带值 |
| `kv` | `Map<ModuleId, TemplateKvRow[]>` | `{}` | 模块须是该条目当前模板上的 `kv` 模块，每行 `key` 非空 |
| `arrangements` | `Map<ModuleId, TemplateMediaArrangement>` | `{}` | 模块须是该条目当前模板上的 `media` 模块 |
| `prose` | `Map<ModuleId, TemplateParagraph[]>` | `{}` | 模块须是该条目当前模板上的 `prose` 模块；段落规格见第 10 节 |

此外，整套 `entries`、`templates`、`memberships` 一起跑 `dr-model` 的图级不变量校验：展开后「自动链接」开着的条目（写了 `auto_link` 的照写的；缺键的照上面的默认算：模板 `linkable`，且住的那一层默认开），其标题与 `aliases_field` 别名不得重名（`V3-AUTOLINK-NAME-UNIQUE`）。条目自己的「自动链接」开关从 2026-11-24 AB 起写进模板（之前的模板文件没有这一项，照默认算；新版没发布，不做旧文件的过渡）。

## 8. 挂名归属（`memberships[]`）

每项为 `{"host": "e…", "member": "e…", "primary"?: bool}`：

- `host` 与 `member` 均须在 `entries` 中存在且 `host != member`；
- `host` 的有效 `accept`（「收别处的条目」）须为 `true`；
- 同一对 `(host, member)` 不得重复；
- 每个 `member` 至多有一条 `primary: true`（对应条目上的 `Entry.primary`）。

## 9. 视图（`views[]`）

每项为 `{"ref": "v…", "name": "…", "lanes": […], "placements": […], "pins": […]}`：

- `ref`：合法代号 `"v…"`，全表唯一；`name`：非空单行文本；
- `lanes`：`{"entry": "e…", "act_track"?: bool}`，`entry` 在同一视图内唯一，且在 `entries` 中存在并开着「收别处的条目」（`accept`；原来是 `level || accept`，2026-11-16 DV 起只开着层级的条目不能当泳道，`V3-TIMELINE-LANE-ENABLED`）；
- `placements`：`{"entry": "e…", "at": f64, "span"?: f64}`，`entry` 在同一视图内唯一，`at` 为有限实数，`span` 存在时为 `> 0` 的有限实数，且 `entry` 须挂名于该视图的某条 `lane`（`check_timeline_placement_in_lane`；原来住在泳道下面也算，2026-11-16 DV 起泳道上只有挂着的）；
- `pins`：`{"at": f64, "label": "…", "color"?: "…", "entry"?: "e…"}`，`at` 有限，`label` 非空，`entry` 存在时须在 `entries` 中存在。

## 10. 正文段落模型（`TemplateParagraph`）

`template_prose["<tpl>/<mod>"]` 与 `entries[].prose["<mod>"]` 共用同一段落数组结构，不存 Loro 块 ID、光标或历史：

- **表格段**：`table` 非空（`{"cols": u32, "rows": TemplateRun[][][]}`），此时 `attrs` 必须为默认空属性、`runs` 必须为空；`cols >= 1`、`rows.len() >= 1`，每行单元格数等于 `cols`。展开建书时生成新的表格 `EmbedId` 与行列 `PosKey`。
- **文字／分隔线段**：`table` 缺省：
  - `attrs`（默认全空时省略）：
    - `heading`：`1` \| `2` \| `3`（仅对应 H1 / H2 / H3 三级标题，含义由作者自定，三级同等对待）；
    - `quote`：`bool`；`indent`：`0..=8`；`align`：`"left"`（默认省略）\| `"center"` \| `"right"`；
    - `rule`：`bool`（为 `true` 时 `runs` 必须为空，且不得与 `heading`、`list`、`code_block`、`callout` 同时出现）；
    - `list`：`"bullet"` \| `"ordered"` \| `"task"`；`list_level`：`u32`（仅 `list` 存在时可 `> 0`）；`checked`：`bool`（仅 `list == "task"` 时可为 `true`，不存任何批注 `todo` id）；
    - `code_block`：语言字符串（存在时不得与 `heading`、`list`、`callout` 共存）；
    - `callout`：非空单行种类字符串（存在时不得与 `heading`、`code_block` 共存）。
  - `runs`（`TemplateRun[]`）：
    - `text`：非空字符串，不含段落结束符 `\n`、对象占位符 `\u{fffc}` 及除 `\t` 外的控制字符（段内软换行保留 `\u{2028}`）；
    - 行内样式：`bold`、`italic`、`underline`、`strike`、`code`（`bool`，`false` 省略），`link`、`highlight`（单行非空字符串，无控制字符）；
    - `entities`（`TemplateEntityLink[]`）：`{"entry": "e…", "module"?: "<模块 id>", "manual"?: true}`。目标条目须在 `entries` 中存在；`manual` 是 @ 挑出来的链接，另存和展开都照带（2026-11-24）；`module` 存在时须是目标条目模板上的 `prose` 模块；同一 `run` 内同一 `entry` 不重复。

## 11. 从项目提取（另存）与展开新建（`project.create`）

### 从项目提取（`extract_project_template`）

1. **只读固定快照与当前正文头**：先导出 `book:<id>` 当前内存快照做一次一致读取，只读未进最近删除（`deleted_at == None` 且有效祖先均未删除）的模板、关系类型、条目、挂名和视图，源项目与 `project.source` 完全不改。
2. **骨架与示例的边界**：
   - 骨架条目为 `entry.has_below(&live_templates)`（即 `level == true` 或有效 `accept == true`）的活条目，默认勾选；被活着的 `project.tabs[].mount`、`templates[].settings.home` 或已选条目 `overrides.home` 指向的有效目标强制纳入（`forced_skeleton_entries`；原来还有 `project.book.root`，2026-11-15 夜里去掉），调用方的 `exclude_skeleton` 点到它们时拒收。若源项目里这些指针的目标本已进最近删除或不再满足开关条件，则导出为缺省 `None`；Tab 例外，这样的 Tab 不导出。
   - 未勾选为示例的骨架条目只保留 `title`、`template`、`level`、`overrides`、`mark`、模块 `color_field` 指定的颜色字段，以及两端都在已选集合内的 `memberships` 与视图 `placements`（保住泳道与线上的骨架结构）。若某骨架条目被取消且它下面仍有被选中的子孙条目，子孙的 `parent` 上提到最近一个保留下来的层级祖先（没有则落顶层）。
   - 勾选进 `sample_entries` 的条目额外带走非图片 `fields`、`kv`、`arrangements` 与当前 `prose`；勾选进 `view_pins` 的视图带走未绑定条目或绑定条目已在模板内的时间钉。
3. **第一期去文件与引用降级**：跳过 `FieldType::Image` 的默认值与字段值、跳过 `media` 模块文件项、跳过正文里的 `EmbedView::Asset` 文件嵌入段；正文与表格里指向未选条目或指向素材库文件（`EntityKind::Asset`）的行内链接去掉链接标记、保留文字与加粗／斜体等原有样式；指向已删条目模板的引用置空。
4. **自定义模块（2026-11-24，CM1）**：带走的条目模板里每个 `custom` 模块指的模块，从书目文档的 `modules` 根取它的抄本，整份放进 `modules`（键还是那个模块 id）。书里没有那份抄本，或者抄本过不了这个 App 的模块校验器（比如更新的 App 存的），整个另存拒绝并说明是哪个模块，不悄悄丢掉。
5. **2026-11-15 夜里加（任务书 DW）**：另存（`project_template.save`）时调用方可以给一份写给 Agent 的话（`agent: {name, description, instructions}`），给了就用它代替项目的 `project.agent`，`null` 就不带，项目不变；替换一份（`replace`）时名字和描述可以不给，不给就留着那一份原来的。编辑模板的工作区随改随存，也走这一条（`save_working_copy`）：活着的条目全部当示例带上，时间钉都带，名字和描述取工作区的书名和简介，写给 Agent 取工作区的项目定义（所以在工作区里调 `save` 给这三样会被拒，改它们用 `project.update`，2026-11-16），`credit`、语言和来源照被替换的那一份留着；提取出来的内容（不算 `revision`、`madeWith`）和模板一样就不写。

### 展开新建（`materialize_project_template` + `project.create`）

1. 所有模板来源（内置「写书」`builtin:novel`、书库 `project-template:<id>`、传入的完整模板值、测试种子）统一先转为并通过 `validate_project_template_value`，再由同一条建书路径落盘。
2. 为每个 `e…`、`v…`、Tab、自定义关系类型、键值行、时间钉、正文块与表格嵌入生成全新 UUIDv7 和分数索引 `PosKey`；把 `source`（`id`、`version`、`origin`、`name`、`credit`）写入新项目的 `project.source`。
3. **自定义模块（2026-11-24）**：`modules` 里的每一份写成新书书目文档 `modules` 根里同一个 id 的抄本（`source = "template"`），和条目模板同一笔写入。模块 id 在新书所在书库的「我的模块」里有，这份抄本就跟着它走（用自己的模板新建的项目）；没有就是跟着别人来的（custom-modules.md 第 7 节）。
4. **写入顺序与失败回滚**：先写／登记全部模板正文初值与条目正文文档，再写 `stats:<book>`、`checkpoints:<book>`、`layout:<book>` 三篇旁路文档，最后写 `book:<book>`。中途任一步失败（含注入故障）按逆序彻底清除并 `forget_purged_doc` 已写文档，不留半个项目或孤儿文档。
