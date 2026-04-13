import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: "hsl(var(--muted))",
        "muted-foreground": "hsl(var(--muted-foreground))",
        border: "hsl(var(--border))",
        accent: "hsl(var(--accent))",
        "accent-foreground": "hsl(var(--accent-foreground))",
        surface: "hsl(var(--surface))",
        panel: "hsl(var(--panel))",
      },
      borderRadius: {
        lg: "1.25rem",
        xl: "1.75rem",
      },
      boxShadow: {
        panel: "0 18px 60px rgba(15, 16, 18, 0.08)",
      },
      fontFamily: {
        sans: ["Avenir Next", "Segoe UI", "Helvetica Neue", "Arial", "sans-serif"],
        serif: ["Iowan Old Style", "Palatino Linotype", "Book Antiqua", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};

export default config;

