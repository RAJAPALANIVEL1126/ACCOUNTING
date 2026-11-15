/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      colors: {
        navy: { 50: '#F3F6FB', 100: '#E3E9F4', 600: '#23407A', 700: '#172B54', 800: '#0F1E3D', 900: '#0B1730', 950: '#070F21' },
        brand: { 50: '#EFF5FF', 100: '#DBE8FE', 500: '#3B82F6', 600: '#2563EB', 700: '#1D4ED8' },
      },
      boxShadow: { card: '0 1px 2px 0 rgb(15 30 61 / 0.05), 0 1px 3px 0 rgb(15 30 61 / 0.06)' },
    },
  },
  plugins: [],
};
