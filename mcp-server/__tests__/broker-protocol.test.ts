import type {
  HelloPayload,
  BrowserInfo,
  BrokerControlRequest,
  BrokerControlResult,
} from "../broker-protocol";

describe("broker-protocol multi-browser shapes", () => {
  it("models a HelloPayload", () => {
    const hello: HelloPayload = {
      type: "hello",
      browserId: "b-1",
      browserType: "chrome",
      label: "Chrome",
    };
    expect(hello.type).toBe("hello");
    expect(hello.browserType).toBe("chrome");
  });

  it("models the list-browsers and select-browser control requests", () => {
    const list: BrokerControlRequest = { control: "list-browsers" };
    const select: BrokerControlRequest = {
      control: "select-browser",
      browserId: "b-2",
    };
    expect(list.control).toBe("list-browsers");
    expect(select.control === "select-browser" && select.browserId).toBe(
      "b-2"
    );
  });

  it("models a BrowserInfo and the widened control result", () => {
    const info: BrowserInfo = {
      browserId: "b-1",
      label: "Chrome",
      type: "chrome",
      connected: true,
      active: false,
    };
    const result: BrokerControlResult = {
      ok: true,
      browsers: [info],
      activeBrowserId: "b-1",
    };
    expect(result.browsers?.[0].type).toBe("chrome");
    expect(result.activeBrowserId).toBe("b-1");
  });
});
