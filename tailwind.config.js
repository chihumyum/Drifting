/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 书卷气色彩系统
        'paper': '#fefdfb',           // 主背景 - 温暖的米白色（纸张色）
        'paper-light': '#f9f6f1',     // 浅色背景 - 稍深的米色
        'paper-hover': '#f5f0e8',     // 悬停/选中背景 - 浅米色
        
        'ink': '#5a4a3a',             // 主文字 - 深棕色（墨水色）
        'ink-dark': '#3a2a1a',        // 更深的墨水色 - 用于编辑器内容
        'ink-darker': '#2a1a0a',      // 最深的墨水色 - 用于标题
        'ink-light': '#8b7355',       // 辅助文字 - 中棕色
        'ink-lighter': '#b8a892',     // 禁用文字 - 浅棕色
        
        // Accent colors - 支持动态主题色 (使用 CSS 变量)
        'accent': 'var(--accent, #b89968)',          // 强调色 - 更 mild 的暖棕色
        'accent-hover': 'var(--accent-hover, #a68858)',    // 强调色悬停 - 稍深的暖棕色
        'accent-active': 'var(--accent-active, #8b6f47)',   // 强调色活跃 - 原来的中等深度棕色
        'accent-border': 'var(--accent-border, #e8dcc8)',          // Accent 边框 - 更淡更 mild 的棕色
        'accent-border-light': 'var(--accent-border-light, #f0e8d8)',    // Accent 次要边框 - 非常淡的棕色
      },
      fontFamily: {
        'serif': ['Georgia', 'Times New Roman', 'Songti SC', 'SimSun', 'serif'],
        'sans': ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'sans-serif'],
      },
      boxShadow: {
        'paper': '0 2px 8px rgba(139, 115, 85, 0.15)',
        'paper-lg': '0 4px 16px rgba(139, 115, 85, 0.2)',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}