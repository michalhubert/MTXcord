import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
    ...nextVitals,

    globalIgnores([
        ".next/**",
        "out/**",
        "build/**",
        "next-env.d.ts",
    ]),

    {
        rules: {
            // Next.js navigation
            "@next/next/no-location-assign-relative-destination": "warn",

            // React Hooks / React Compiler rules
            "react-hooks/set-state-in-effect": "warn",
            "react-hooks/refs": "warn",
            "react-hooks/exhaustive-deps": "warn",

            // JSX text like: "Don't do this"
            "react/no-unescaped-entities": "warn",
        },
    },

    {
        // Playwright fixtures call use(), which the hooks rule mistakes for React's use().
        files: ["tests/e2e/**"],
        rules: {
            "react-hooks/rules-of-hooks": "off",
        },
    },
]);

export default eslintConfig;