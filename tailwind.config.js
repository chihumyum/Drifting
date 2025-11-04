/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'card': 'rgba(254, 250, 224, 1)',      // 卡片背景色 - 淡黄色
        'button': 'rgba(227, 213, 202, 1)',    // 按钮背景色 - 淡褐色
        'mild': 'rgba(254, 252, 245, 1)',      // 柔和背景色 - 极淡黄色
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}