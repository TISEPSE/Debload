import { afterEach, describe, expect, it } from "vitest";

import { applyTheme } from "./theme";

/** Un réglage système qu'on peut basculer pendant le test. */
function fakeSystem(light: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: light,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => media,
  });

  return {
    switchTo(next: boolean) {
      media.matches = next;
      listeners.forEach((listener) => listener());
    },
  };
}

const current = () => document.documentElement.dataset.theme;

describe("applyTheme", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("pose le thème choisi, quel que soit le système", () => {
    fakeSystem(true);

    applyTheme("dark");
    expect(current()).toBe("dark");

    applyTheme("light");
    expect(current()).toBe("light");
  });

  it("suit le système, et ses changements en cours de route", () => {
    const system = fakeSystem(true);

    applyTheme("system");
    expect(current()).toBe("light");

    system.switchTo(false);
    expect(current()).toBe("dark");
  });

  it("cesse de suivre le système une fois remplacé", () => {
    const system = fakeSystem(false);

    const stop = applyTheme("system");
    stop();
    system.switchTo(true);

    expect(current()).toBe("dark");
  });

  it("retombe sur le sombre quand le système ne dit rien", () => {
    applyTheme("system");
    expect(current()).toBe("dark");
  });
});
