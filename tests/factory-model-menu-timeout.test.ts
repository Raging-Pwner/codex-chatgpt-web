import { expect, test } from "bun:test";
import { activateChatGptEffortMenu } from "../src/chatgpt-ui/model-picker";

function fixture(error: Error, clickOpened = false, pointerWorks = true) {
  let opened = false;
  let pointers = 0;
  const surface = { filter() { return this; }, locator() { return this; }, isVisible: async () => opened };
  const control = {
    getAttribute: async (name: string) => name === "aria-expanded" ? String(opened)
      : name === "data-state" ? opened ? "open" : "closed" : null,
    click: async () => { opened = clickOpened; throw error; },
    dispatchEvent: async () => { pointers++; opened = pointerWorks; },
  };
  const page = { locator: () => surface, keyboard: { press: async () => { opened = false; } } };
  return { page, control, pointers: () => pointers };
}
const timeout = () => Object.assign(new Error("locator.click: Timeout 3000ms exceeded"), { name: "TimeoutError" });

test("a model-menu click timeout still reaches the bounded owned-surface fallback", async () => {
  const f = fixture(timeout());
  const result = await activateChatGptEffortMenu(f.page as never, f.control as never, { settleMs: 0 });
  expect(result.method).toBe("pointerdown"); expect(f.pointers()).toBe(1);
});
test("a timeout after opening the owned menu never toggles it closed", async () => {
  const f = fixture(timeout(), true);
  const result = await activateChatGptEffortMenu(f.page as never, f.control as never, { settleMs: 0 });
  expect(result.method).toBe("click"); expect(f.pointers()).toBe(0);
});
test("a timeout with no structural menu still fails closed", async () => {
  const f = fixture(timeout(), false, false);
  await expect(activateChatGptEffortMenu(f.page as never, f.control as never, { settleMs: 0 }))
    .rejects.toThrow("did not expose its owned menu or structural slider");
  expect(f.pointers()).toBe(1);
});
test("non-timeout browser failures never invoke the fallback", async () => {
  const error = new Error("Target page has been closed"); const f = fixture(error);
  await expect(activateChatGptEffortMenu(f.page as never, f.control as never, { settleMs: 0 })).rejects.toBe(error);
  expect(f.pointers()).toBe(0);
});
