import { describe, expect, it } from "vitest";

describe("smoke", () => {
	it("package exports exist", async () => {
		const mod = await import("../src/index.js");
		expect(mod.SimulationEngine).toBeDefined();
		expect(mod.PersonaBuilder).toBeDefined();
		expect(mod.VoiceNarrator).toBeDefined();
		expect(mod.MemeSoundboard).toBeDefined();
	});
});
