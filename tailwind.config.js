/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      /* ─── Font families — Drifting design system ─── */
      fontFamily: {
        serif: ['var(--font-serif)'],
        sans:  ['var(--font-sans)'],
        mono:  ['var(--font-mono)'],
      },

      /* ─── Border radius ─── */
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },

      /* ─── Colors — keep shadcn tokens + add Drifting tokens ─── */
      colors: {
        /* shadcn-style (existing code keeps working) */
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',

        /* Drifting-only — paper / ink scale */
        paper: {
          DEFAULT: 'hsl(var(--paper))',
          deep:    'hsl(var(--paper-deep))',
        },
        surface: 'hsl(var(--surface))',
        page:    'hsl(var(--page))',
        ink: {
          DEFAULT: 'hsl(var(--ink-1))',
          1: 'hsl(var(--ink-1))',
          2: 'hsl(var(--ink-2))',
          3: 'hsl(var(--ink-3))',
          4: 'hsl(var(--ink-4))',
          5: 'hsl(var(--ink-5))',
        },
        rule: 'hsl(var(--rule))',

        /* Storyline track palette — use e.g. bg-story-1 / text-story-3 */
        story: {
          1: 'hsl(var(--story-1))',
          2: 'hsl(var(--story-2))',
          3: 'hsl(var(--story-3))',
          4: 'hsl(var(--story-4))',
          5: 'hsl(var(--story-5))',
          6: 'hsl(var(--story-6))',
        },

        /* Element category semantic */
        el: {
          person: 'hsl(var(--el-person))',
          place:  'hsl(var(--el-place))',
          item:   'hsl(var(--el-item))',
          period: 'hsl(var(--el-period))',
          lex:    'hsl(var(--el-lex))',
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
