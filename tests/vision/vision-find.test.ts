/// <reference types="jest" />
import { getVisionMode } from "../../src/vision/config";

describe("getVisionMode", () => {
  const orig = process.env.OPENCHROME_VISION_MODE;
  afterEach(() => { if (orig === undefined) delete process.env.OPENCHROME_VISION_MODE; else process.env.OPENCHROME_VISION_MODE = orig; });
  it("returns fallback by default", () => { delete process.env.OPENCHROME_VISION_MODE; expect(getVisionMode()).toBe("fallback"); });
  it("returns off when set", () => { process.env.OPENCHROME_VISION_MODE = "off"; expect(getVisionMode()).toBe("off"); });
  it("returns auto when set", () => { process.env.OPENCHROME_VISION_MODE = "auto"; expect(getVisionMode()).toBe("auto"); });
  it("returns fallback for invalid", () => { process.env.OPENCHROME_VISION_MODE = "invalid"; expect(getVisionMode()).toBe("fallback"); });
});

describe("VisionFindTool", () => {
  const mkPage = (elems: any[] = []) => ({
    evaluate: jest.fn().mockImplementation((_fn: Function, ...args: unknown[]) => {
      if (args.length === 3 && typeof args[2] === "string" && String(args[2]).includes("oc_vision")) return Promise.resolve();
      if (args.length === 1 && typeof args[0] === "string" && String(args[0]).includes("oc_vision")) return Promise.resolve();
      return Promise.resolve(elems);
    }),
    screenshot: jest.fn().mockResolvedValue(Buffer.from("fake")),
    viewport: jest.fn().mockReturnValue({ width: 1920, height: 1080 }),
  });

  const getHandler = async () => {
    jest.resetModules();
    const page = mkPage([{ role: "button", name: "Submit", x: 100, y: 200, width: 80, height: 30 }, { role: "link", name: "Home", x: 10, y: 10, width: 60, height: 20 }]);
    const sm = { getPage: jest.fn().mockResolvedValue(page), getAvailableTargets: jest.fn().mockResolvedValue([]) };
    jest.doMock("../../src/session-manager", () => ({ getSessionManager: () => sm }));
    const { registerVisionFindTool } = await import("../../src/tools/vision-find");
    const tools: Record<string, Function> = {};
    registerVisionFindTool({ registerTool: (n: string, h: Function) => { tools[n] = h; } } as any);
    return { handler: tools["vision_find"], page, sm };
  };

  it("returns annotated screenshot", async () => {
    const { handler } = await getHandler();
    const r = await handler("s1", { tabId: "t1" }, { startTime: Date.now(), deadlineMs: 120000 });
    expect(r.content).toHaveLength(2);
    expect(r.content[0].text).toContain("2 elements found");
    expect(r.content[1].type).toBe("image");
  });

  it("errors on missing tabId", async () => {
    const { handler } = await getHandler();
    const r = await handler("s1", {});
    expect(r.isError).toBe(true);
  });

  it("errors on missing tab", async () => {
    const { handler, sm } = await getHandler();
    sm.getPage.mockResolvedValueOnce(null);
    const r = await handler("s1", { tabId: "bad" }, { startTime: Date.now(), deadlineMs: 120000 });
    expect(r.isError).toBe(true);
  });

  it("errors on low budget", async () => {
    const { handler } = await getHandler();
    const r = await handler("s1", { tabId: "t1" }, { startTime: Date.now() - 115000, deadlineMs: 120000 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("insufficient budget");
  });
});

describe("FindTool vision_fallback schema", () => {
  it("includes vision_fallback property", async () => {
    jest.resetModules();
    const { registerFindTool } = await import("../../src/tools/find");
    const tools: Record<string, any> = {};
    registerFindTool({ registerTool: (n: string, _h: Function, d: any) => { tools[n] = d; } } as any);
    expect(tools["find"].inputSchema.properties.vision_fallback).toBeDefined();
    expect(tools["find"].inputSchema.properties.vision_fallback.type).toBe("boolean");
  });
});
