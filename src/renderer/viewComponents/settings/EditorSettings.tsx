import { useSettingsStore } from '../../store/settings-store';

/**
 * 编辑器设置面板
 * 包含自动元素链接等功能的开关
 */
export function EditorSettings() {
  const {
    autoElementLinkEnabled,
    setAutoElementLinkEnabled,
    recentEntitiesLimit,
    setRecentEntitiesLimit,
  } = useSettingsStore();

  return (
    <div className="editor-settings p-4 bg-gray-800 rounded-lg">
      <h3 className="text-sm font-semibold text-gray-200 mb-3">编辑器设置</h3>

      <div className="space-y-2">
        <label className="flex items-center justify-between cursor-pointer group">
          <div className="flex-1">
            <div className="text-sm text-gray-300 group-hover:text-white transition-colors">
              自动元素链接
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              自动识别并高亮文本中的元素名称（如角色、地点等）
            </div>
          </div>

          <div className="ml-3">
            <input
              type="checkbox"
              checked={autoElementLinkEnabled}
              onChange={(e) => setAutoElementLinkEnabled(e.target.checked)}
              className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 focus:ring-2"
            />
          </div>
        </label>

        <label className="flex items-center justify-between cursor-pointer group">
          <div className="flex-1">
            <div className="text-sm text-gray-300 group-hover:text-white transition-colors">
              最近使用 Entity 数量
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              Project Home 顶部时间轴最多显示多少条最近使用记录（1-50）
            </div>
          </div>
          <div className="ml-3">
            <input
              type="number"
              min={1}
              max={50}
              value={recentEntitiesLimit}
              onChange={(e) => setRecentEntitiesLimit(Number(e.target.value))}
              className="w-16 px-2 py-1 text-sm text-gray-100 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </label>
      </div>

      {autoElementLinkEnabled && (
        <div className="mt-3 p-2 bg-blue-900/20 border border-blue-700/30 rounded text-xs text-blue-300">
          💡 输入时会自动检测元素名称（如"德古拉"），点击可跳转到元素详情
        </div>
      )}
    </div>
  );
}
