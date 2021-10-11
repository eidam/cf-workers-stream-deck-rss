const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: ["./src/main.ts"],
    bundle: true,
    format: "esm",
    outfile: "./dist/main.mjs",
    plugins: []
  })
  .catch(() => process.exit(1));
