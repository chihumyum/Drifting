# 预置样式不再覆盖 ::before 与 ::after（2026-10-30）

## 问题

Tailwind 的预置样式（preflight）开头是：

```css
*, ::after, ::before, ::backdrop, ::file-selector-button {
  box-sizing: border-box; margin: 0; padding: 0; border: 0 solid;
}
```

这条通配规则包含伪元素，WebKit 因此在每次重算一个元素的样式时，都要把它的 `::before` 和 `::after` 也各解析一遍，即使这两个伪元素并不存在。挂载大量元素时，这部分占样式计算的三分之一左右。

在 Debug 实例上对打开要素全景（约 4900 个元素，含 300 张卡片）连续采样四次，样式计算的采样数：

| | 采样数 |
| --- | ---: |
| 修改前 | 359 |
| 修改后 | 233 |

## 修复

`scripts/postcss-preflight-pseudo-elements.cjs` 在 `postcss.config.cjs` 中排在 Tailwind 之后。它只把预置样式那条规则里的 `::before`、`::after` 去掉，其余选择器和声明不变。

Tailwind 为不支持 `@property` 的浏览器准备的回退块里也有同样的选择器，但它包在一个在 WebKit 中为假的 `@supports` 条件里，不生效，所以保持原样。

## 为什么外观不变

伪元素的 `margin`、`padding` 初始值本来就是 0，`border-style` 初始值是 `none`。去掉预置样式后，只有两类伪元素会变样：

- 设了宽或高，同时设了内边距或边框，靠预置样式得到 `border-box`；
- 只设了边框宽度或颜色，靠预置样式得到 `solid`。

### 静态审计

审计覆盖 `src/styles` 下全部 168 条伪元素规则，结果：

- 移动端时间轴的 `.m-vtl__handle::before`（9×9，1px 边框）属于第一类，已补上 `box-sizing: border-box`；
- Tiptap 的 gapcursor 只有宽度和上边框，不受影响；
- 组件里没有使用 Tailwind 的 `before:`、`after:` 变体。

### 运行时比对

在运行中的应用里分别打开以下视图：

- 项目主页与两侧侧栏；
- 编辑器；
- 故事图、要素全景、素材工作台。

对每个实际渲染出的伪元素（共 242–431 个），比较切换前后的边框宽度、盒模型和尺寸，没有差异。

## 测试

`src/renderer/performance/preflight-pseudo-elements.test.ts`：

- 用真实的 Tailwind 构建 `index.css`，断言输出里除了不生效的回退块，再没有以 `::before`、`::after` 为通配的规则；
- 断言插件在 PostCSS 配置中排在 Tailwind 之后；
- 审计 `src/styles` 中"有尺寸又有内边距或边框、却没声明 `box-sizing`"的伪元素规则，只允许 Tiptap 的 gapcursor 这一条。

新增此类伪元素时，需要自己声明 `box-sizing`。
