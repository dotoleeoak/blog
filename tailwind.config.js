module.exports = {
  content: ['./.vitepress/**/*.{html,ts,vue}'],
  theme: {
    extend: {}
  },
  plugins: [require('@tailwindcss/typography')]
}
