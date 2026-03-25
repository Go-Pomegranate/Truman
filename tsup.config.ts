import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/cli.ts"],
	format: ["esm"],
	dts: true,
	outDir: "dist",
	clean: true,
	splitting: true,
	external: ["playwright", "openai", "@anthropic-ai/sdk"],
});
