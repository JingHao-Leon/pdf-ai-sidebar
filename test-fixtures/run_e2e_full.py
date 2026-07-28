"""完整端到端测试：mock DeepSeek → 扩展 → side panel。"""
import json
import os
import re
import subprocess
import sys
import time
import threading
from pathlib import Path
from http.server import HTTPServer

from playwright.sync_api import sync_playwright

PROJECT = Path("/Users/ahs/Documents/一坨/pdf-ai-sidebar")
PROFILE_DIR = "/tmp/pdf-ai-e2e-profile"
SCREENSHOT_DIR = PROJECT / "test-fixtures" / "screenshots"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

CHROME = "/Users/ahs/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

MOCK_ENDPOINT = "http://127.0.0.1:18765/v1/chat/completions"
CONTEXT_TEXT = "Transformer 是一种基于自注意力机制的神经网络架构，由 Vaswani 等人在 2017 年的论文《Attention Is All You Need》中提出。它彻底改变了自然语言处理领域，并在计算机视觉、语音识别等多个领域取得了突破性进展。"


def shot(page, name):
    path = SCREENSHOT_DIR / f"{name}.png"
    page.screenshot(path=str(path))
    print(f"  shot: {path.name}")
    return path


def main():
    subprocess.run(["rm", "-rf", PROFILE_DIR], check=False)

    print("[0] 启动 mock DeepSeek server...")
    from mock_deepseek import MockDeepSeekHandler
    from socketserver import ThreadingMixIn

    class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

    server = ThreadedHTTPServer(("127.0.0.1", 18765), MockDeepSeekHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"  mock server up: {MOCK_ENDPOINT}")

    try:
        with sync_playwright() as p:
            print("[1] 启动 Chrome + 加载扩展...")
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=PROFILE_DIR,
                executable_path=CHROME,
                headless=False,
                args=[
                    f"--load-extension={PROJECT}",
                    f"--disable-extensions-except={PROJECT}",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--window-size=1280,800",
                ],
                viewport={"width": 1280, "height": 800},
            )

            print("[2] 等待 service worker...")
            sw = None
            deadline = time.time() + 60
            while time.time() < deadline:
                if ctx.service_workers:
                    sw = ctx.service_workers[0]
                    break
                time.sleep(0.5)
            if not sw:
                # 尝试主动触发：导航到一个页面让扩展激活
                page = ctx.new_page()
                page.goto("about:blank")
                time.sleep(2.0)
                deadline = time.time() + 30
                while time.time() < deadline:
                    if ctx.service_workers:
                        sw = ctx.service_workers[0]
                        break
                    time.sleep(0.5)
            if not sw:
                print("  FAIL: service worker not up")
                return
            m = re.search(r"chrome-extension://([a-z]+)/", sw.url)
            ext_id = m.group(1)
            print(f"  ext id: {ext_id}")

            options_url = f"chrome-extension://{ext_id}/src/options/options.html"
            sidepanel_url = f"chrome-extension://{ext_id}/src/sidepanel/sidepanel.html"

            print("[3] 把 deepseek endpoint 指向 mock server...")
            page = ctx.new_page()
            page.goto(options_url, wait_until="domcontentloaded")
            page.wait_for_selector(".agent-item", timeout=10000)
            page.evaluate(
                """async (ep) => {
                    const cfg = await chrome.storage.sync.get(['agents', 'defaultAgent']);
                    cfg.agents.deepseek.endpoint = ep;
                    cfg.agents.deepseek.apiKey = 'mock-key-not-used';
                    cfg.defaultAgent = 'deepseek';
                    await chrome.storage.sync.set(cfg);
                    return true;
                }""",
                MOCK_ENDPOINT,
            )
            time.sleep(0.5)
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".agent-item", timeout=10000)
            time.sleep(0.5)
            shot(page, "e2e-01-options-mock")

            print("[4] 打开 sidepanel 注入 context...")
            page.goto(sidepanel_url, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            page.evaluate(
                """async (ctx) => {
                    await chrome.storage.session.set({
                        pendingPrompt: { text: ctx, agent: 'deepseek' },
                        selection: ctx,
                        selectionUrl: 'file:///test-paper.pdf',
                    });
                }""",
                CONTEXT_TEXT,
            )
            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            time.sleep(1.0)
            shot(page, "e2e-02-sidepanel-context")

            print("[5] 输入问题并发送...")
            page.locator("#user-input").fill("请用通俗易懂的语言解释这段话")
            time.sleep(0.3)
            shot(page, "e2e-03-question-typed")
            page.locator("#send-btn").click()
            print("  等待流式响应...")
            page.wait_for_selector(".msg.assistant .bubble", timeout=10000)
            time.sleep(0.6)
            shot(page, "e2e-04-streaming-start")
            time.sleep(4.5)
            shot(page, "e2e-05-streaming-complete")

            content = page.evaluate(
                """() => {
                    const bs = document.querySelectorAll('.msg.assistant .bubble');
                    if (!bs.length) return null;
                    const last = bs[bs.length - 1];
                    return {
                        len: last.innerText.length,
                        htmlLen: last.innerHTML.length,
                        hasCopy: !!last.querySelector('.copy-btn'),
                    };
                }"""
            )
            print(f"  assistant 回答: text 长度 {content['len']}, html {content['htmlLen']}, 复制按钮 {content['hasCopy']}")

            print("[6] 多轮对话...")
            page.locator("#user-input").fill("它和 RNN 最大的区别是什么？")
            time.sleep(0.3)
            page.locator("#send-btn").click()
            page.wait_for_function(
                """() => {
                    const bs = document.querySelectorAll('.msg.assistant .bubble');
                    if (bs.length < 2) return false;
                    const last = bs[bs.length - 1];
                    return last.innerText.length > 50;
                }""",
                timeout=15000,
            )
            time.sleep(0.5)
            # 把最后一个 AI 回答滚到视图里
            page.evaluate(
                """() => {
                    const bs = document.querySelectorAll('.msg.assistant .bubble');
                    bs[bs.length - 1].scrollIntoView({ block: 'center' });
                }"""
            )
            time.sleep(0.3)
            shot(page, "e2e-06-multi-turn")
            msg_count = page.evaluate("() => document.querySelectorAll('.msg').length")
            print(f"  当前消息总数: {msg_count}")

            ctx.close()
            print("\nDONE")
    finally:
        server.shutdown()
        print("mock server stopped")


if __name__ == "__main__":
    main()