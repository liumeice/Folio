/* 测试用最小 DOM。每个测试文件在独立进程中运行，安装后不影响其它文件。 */
import { JSDOM } from "jsdom";

export function installDom(html = ""): JSDOM {
  const dom = new JSDOM(html);
  const g = globalThis as unknown as Record<string, unknown>;
  g.DOMParser = dom.window.DOMParser;
  g.document = dom.window.document;
  g.window = dom.window;
  return dom;
}

export function uninstallDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.DOMParser;
  delete g.document;
  delete g.window;
}