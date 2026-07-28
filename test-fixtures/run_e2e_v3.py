"""E2E v3: popup 模式测试。

流程：
1. mock server（DeepSeek 替身）
2. 启动 Chrome + 加载扩展
3. 配置 deepseek 指向 mock
4. 模拟用户：右键 → DeepSeek → 写入 storage.session
5. 直接打开 popup 页面，验证：
   - 选中段落显示
   - 📁 选文件按钮显示
   - 选文件 → 全文加载 → 状态变绿
   - 输入问题 → 收到流式响应
6. 截图
"""
import os
import re
import subprocess
import sys
import time
import threading
import json
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

from playwright.sync_api import sync_playwright

PROJECT = Path("/Users/ahs/Documents/一坨/pdf-ai-sidebar")
PROFILE_DIR = "/tmp/pdf-ai-popup-profile"
SCREENSHOT_DIR = PROJECT / "test-fixtures" / "screenshots"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

CHROME = "/Users/ahs/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

MOCK_ENDPOINT = "http://127.0.0.1:18780/v1/chat/completions"

MOCK_PDF_TEXT = """测试论文：Transformer 架构

第 1 章 引言
Transformer 是 2017 年由 Vaswani 等人提出的神经网络架构...

第 2 章 自注意力机制
自注意力机制是 Transformer 的核心...

第 3 章 编码器
编码器由 6 个相同的层堆叠而成...

第 4 章 局限
计算复杂度是 O(n^2)...
"""

MOCK_AI_RESPONSE = """基于这篇 Transformer 综述文档，让我解释你选中的这段话。

**段落位置**
你选中的这段话出现在第 1 章（引言），是整个文档的开篇导引段落，交代了 Transformer 的历史背景。

**核心意思**
- 时间：2017 年
- 提出者：Vaswani 等人
- 重要意义：开创了一种新的神经网络架构

**与文档其他部分的关系**
- 与第 2 章"自注意力机制"对应：第 1 章说"提出 Transformer"，第 2 章解释"Transformer 的核心是什么"
- 与第 4 章"局限"形成首尾呼应：第 1 章强调"突破性进展"，第 4 章冷静指出"局限"

简单说：这段话是整篇文档的"开场白"，告诉你"为什么 Transformer 重要"。"""


class MockHandler(BaseHTTPRequestHandler):
    captured = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode()
        try:
            data = json.loads(body)
        except Exception:
            data = {}
        if "/chat/completions" not in self.path:
            self.send_response(404)
            self.end_headers()
            return
        MockHandler.captured.append(data)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.close_connection = True
        for tk in MOCK_AI_RESPONSE.split("\n"):
            chunk = {"choices": [{"delta": {"content": tk + "\n"}}]}
            self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
            time.sleep(0.04)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, *a):
        pass


class THS(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def shot(page, name):
    path = SCREENSHOT_DIR / f"{name}.png"
    page.screenshot(path=str(path))
    print(f"  shot: {path.name}")


def main():
    subprocess.run(["rm", "-rf", PROFILE_DIR], check=False)
    MockHandler.captured = []
    server = THS(("127.0.0.1", 18780), MockHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"mock server: {MOCK_ENDPOINT}")

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

            print("[2] 激活 SW（打开 chrome://extensions）...")
            p0 = ctx.new_page()
            p0.goto("chrome://extensions/")
            time.sleep(2)
            sw = None
            for _ in range(60):
                if ctx.service_workers:
                    sw = ctx.service_workers[0]
                    break
                time.sleep(0.5)
            if not sw:
                print("  FAIL: SW not up")
                return
            m = re.search(r"chrome-extension://([a-z]+)/", sw.url)
            ext_id = m.group(1)
            print(f"  ext id: {ext_id}")
            p0.close()

            options_url = f"chrome-extension://{ext_id}/src/options/options.html"
            popup_url = f"chrome-extension://{ext_id}/src/popup/popup.html"

            print("[3] 配置 deepseek 指向 mock...")
            page = ctx.new_page()
            page.goto(options_url, wait_until="domcontentloaded")
            page.wait_for_selector(".agent-item", timeout=10000)
            page.evaluate(
                """async (ep) => {
                    const cfg = await chrome.storage.sync.get(['agents', 'defaultAgent']);
                    if (!cfg.agents) cfg.agents = {};
                    if (!cfg.agents.deepseek) {
                        cfg.agents.deepseek = {label:'DeepSeek', endpoint:ep, model:'deepseek-chat', apiKey:'mock'};
                    } else {
                        cfg.agents.deepseek.endpoint = ep;
                        cfg.agents.deepseek.apiKey = 'mock';
                    }
                    cfg.defaultAgent = 'deepseek';
                    await chrome.storage.sync.set(cfg);
                }""",
                MOCK_ENDPOINT,
            )

            print("[4] 直接打开 popup，注入 storage（模拟右键 → DeepSeek 结果）...")
            page.goto(popup_url, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")

            pdf_url = "file:///Users/ahs/Downloads/test-paper.pdf"
            page.evaluate(
                """async (data) => {
                    await chrome.storage.session.set({
                        pendingPrompt: {
                            text: data.selectedText,
                            agent: 'deepseek',
                            pdfUrl: data.pdfUrl,
                            hasFullText: false,
                            pdfNumPages: 4,
                            pdfChars: 0,
                            defaultQuestion: '这段话在文档的什么位置？',
                        },
                        selection: data.selectedText,
                        selectionUrl: data.pdfUrl,
                    });
                }""",
                {
                    "pdfUrl": pdf_url,
                    "selectedText": "Transformer 是 2017 年由 Vaswani 等人提出的神经网络架构",
                },
            )

            print("[5] 触发 storage.onChanged...")
            # 重新写入触发 onChanged
            page.evaluate(
                """async (data) => {
                    await chrome.storage.session.set({
                        pendingPrompt: {
                            text: data.selectedText,
                            agent: 'deepseek',
                            pdfUrl: data.pdfUrl,
                            hasFullText: false,
                            pdfNumPages: 4,
                            pdfChars: 0,
                            defaultQuestion: '这段话在文档的什么位置？',
                        },
                    });
                }""",
                {
                    "pdfUrl": pdf_url,
                    "selectedText": "Transformer 是 2017 年由 Vaswani 等人提出的神经网络架构",
                },
            )
            time.sleep(1.5)
            shot(page, "v3-01-popup-with-selection")

            # 检查 UI
            status = page.evaluate(
                """() => ({
                    contextText: document.getElementById('context-text').innerText,
                    fullDocStatus: document.getElementById('full-doc-status').innerText,
                    userInput: document.getElementById('user-input').value,
                })"""
            )
            print(f"  context text: {status['contextText'][:60]}")
            print(f"  full doc status: {status['fullDocStatus']}")
            print(f"  user input: {status['userInput']}")

            # 看 picker 按钮是否显示
            picker_visible = page.evaluate(
                """() => {
                    const b = document.getElementById('load-pdf-btn');
                    return b ? getComputedStyle(b).display !== 'none' : false;
                }"""
            )
            print(f"  picker button visible: {picker_visible}")

            print("[6] 模拟用户上传 PDF 文件（注入 buffer 模拟 File.arrayBuffer）...")
            # 模拟上传文件（实际测试用 mock 数据，但走真实 PDF.js 解析）
            # 用我之前生成的 test-paper.pdf
            pdf_file = PROJECT / "test-fixtures" / "test-paper.pdf"
            if not pdf_file.exists():
                print(f"  FAIL: 测试 PDF 不存在 {pdf_file}")
                return

            # Playwright 的 set_input_files 真实触发 change 事件
            page.set_input_files("#pdf-file-input", str(pdf_file))
            # 等待全文加载
            page.wait_for_function(
                """() => document.getElementById('full-doc-status').className.includes('ready')""",
                timeout=30000,
            )
            time.sleep(0.5)
            shot(page, "v3-02-popup-with-fulldoc")

            # 状态
            status2 = page.evaluate(
                """() => document.getElementById('full-doc-status').innerText"""
            )
            print(f"  full doc status: {status2}")

            print("[7] 输入问题并发送...")
            # 已经有 defaultQuestion 在输入框里
            page.locator("#user-input").fill(
                "请基于全文，解释我选中的这段话在文档的什么位置？"
            )
            time.sleep(0.3)
            shot(page, "v3-03-question-typed")
            page.locator("#send-btn").click()
            # 等流式
            page.wait_for_function(
                """() => {
                    const bs = document.querySelectorAll('.msg.assistant .bubble');
                    return bs.length >= 1 && bs[bs.length-1].innerText.length > 100;
                }""",
                timeout=20000,
            )
            time.sleep(2)
            # 滚动到顶部让 user 气泡可见
            page.evaluate("() => { document.getElementById('chat').scrollTop = 0; }")
            time.sleep(0.3)
            shot(page, "v3-04-streaming-complete")

            # 看 prompt 内容
            print(f"[8] 验证 mock 收到的 prompt...")
            print(f"  captured count: {len(MockHandler.captured)}")
            if MockHandler.captured:
                prompt = MockHandler.captured[-1].get("messages", [{}])[0].get("content", "")
                print(f"  prompt length: {len(prompt)}")
                print(f"  包含'文档全文': {'【文档全文】' in prompt}")
                print(f"  包含'我选中的内容': {'【我选中的内容】' in prompt}")
                print(f"  包含'测试论文': {'测试论文' in prompt}")
                print(f"  包含'第 1 章': {'第 1 章' in prompt}")
                print(f"  包含用户问题: {'文档的什么位置' in prompt}")

            ctx.close()
            print("\nDONE")
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()