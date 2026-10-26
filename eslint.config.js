import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: ["dist/", "build/", "node_modules/", "wailsjs/"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      "no-console": "warn",
      "prefer-const": "error",
    },
  },
  {
    // tests/ 与 scripts/ 也纳入 lint（轮85）：以前 lint 只看 src/，
    // 用例里的未使用变量、可变绑定、hooks 违规全都无人管——
    // 而用例是这个项目里唯一"改了不会有人报警"的一层，静态层能拦的先拦掉。
    // no-console 在这里关掉：真机用例靠 console 打印读数（失败时日志就是证据），
    // 这不是遗漏，是这套测试的设计。
    files: ["tests/**/*.{ts,tsx}", "scripts/**/*.{mjs,js}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
    },
    rules: {
      // Playwright 的 test.extend 里那个 use(a,b) 会被 react-hooks 认成 React Hook，
      // 实测 6 处误报（retestTest.ts:19、smokeTest.ts:14、nativeTest.ts:28/39×2 等）。
      // 这里的用例文件不写 React 组件，规则整块关掉，而不是逐个文件 eslint-disable。
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      "no-console": "off",
      "prefer-const": "error",
    },
  },
];
