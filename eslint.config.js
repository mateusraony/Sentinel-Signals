import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginUnusedImports from "eslint-plugin-unused-imports";

export default [
  {
    // Testes rodam no Node (vitest), nao no browser: `global`, `process` e
    // afins sao legitimos aqui. Sem este bloco, ligar `no-undef` acusaria
    // 32 falsos positivos e a tentacao seria desligar a regra de novo.
    files: ["**/*.test.{js,mjs,cjs,jsx}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // TODO o codigo de producao, nao uma lista de subpastas. A lista anterior
    // enumerava components/pages/lib/api/hooks + Layout.jsx e deixava de fora
    // src/App.jsx e src/main.jsx — os dois pontos de entrada. Como o comando
    // da CI e `eslint . --quiet`, arquivo nao coberto nao vira nem aviso: o
    // lint saia VERDE com variavel indefinida em App.jsx, que derruba o app
    // inteiro (nao so uma pagina). Achado de review no PR #305, confirmado
    // empiricamente. Ver docs/known-risks.md item 157 addendum.
    files: ["src/**/*.{js,mjs,cjs,jsx}"],
    ignores: ["src/components/ui/**/*"],
    ...pluginJs.configs.recommended,
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      // O spread de pluginJs.configs.recommended acima e' sobrescrito pelo
      // spread do pluginReact e depois por este bloco `rules` — as regras
      // recomendadas do JS eram descartadas em silencio. `no-undef` estava
      // entre elas, e a ausencia dela deixou passar um `useState` declarado
      // no componente ERRADO: lint/test/build verdes, pagina /trades quebrada
      // em producao com "Can't find variable". Ver docs/known-risks.md item 157.
      "no-undef": "error",
      "no-unused-vars": "off",
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": [
        "error",
        { ignore: ["cmdk-input-wrapper", "toast-close"] },
      ],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
