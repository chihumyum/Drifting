module.exports = {
  plugins: [
    require('@tailwindcss/postcss'),
    // After Tailwind, which inlines its preflight here.
    require('./scripts/postcss-preflight-pseudo-elements.cjs')(),
    require('autoprefixer'), // 依然保留 autoprefixer 是好的实践，虽然 v4 处理了很多
  ],
};
