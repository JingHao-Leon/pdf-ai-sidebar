"""端到端测试 v2：全文上下文模式。

不依赖真 PDF 解析（content script 进 Chrome viewer 难，background fetch file:// 需 file_access）。
策略：
1. 启动 mock server
2. 在 Chrome 扩展加载后，直接用 page.evaluate 写入 storage.session 的 pdfFullText（mock 一个 PDF 全文）
3. 在 sidepanel 里验证 UI 显示"全文已加载"
4. 发送问题，验证 mock server 收到的 prompt 里包含全文 + 选中文本
5. 截图各种状态
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
PROFILE_DIR = "/tmp/pdf-ai-e2e-v2-profile"
SCREENSHOT_DIR = PROJECT / "test-fixtures" / "screenshots"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

CHROME = "/Users/ahs/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

MOCK_ENDPOINT = "http://127.0.0.1:18766/v1/chat/completions"

# 模拟一篇 PDF 全文（演示用，从真实 PDF 内容简化）
MOCK_PDF_TEXT = """Transformer 架构综述

第 1 章 引言
近年来，深度学习在自然语言处理领域取得了突破性进展。Transformer 架构由 Vaswani 等人在 2017 年的论文《Attention Is All You Need》中首次提出，彻底改变了序列建模的范式。本章将介绍 Transformer 的基本概念、历史背景及其在 NLP 领域的重要地位。

第 2 章 自注意力机制
Transformer 的核心是自注意力机制（Self-Attention）。与传统的循环神经网络（RNN）不同，自注意力允许模型在处理序列的每个位置时，同时关注序列中的所有其他位置。这种"全局视野"使得模型能够有效捕捉长距离依赖关系。具体而言，自注意力的计算过程可以分为三个步骤：Query、Key、Value 的线性变换；注意力权重的计算（通过 Q 和 K 的点积）；加权求和。

第 3 章 多头注意力
为了增强模型的表达能力，Transformer 引入了多头注意力（Multi-Head Attention）。其核心思想是将输入投影到多个子空间，在每个子空间独立计算注意力，最后拼接结果。多头注意力允许模型同时关注不同位置的不同表示子空间的信息，显著提升了模型性能。

第 4 章 位置编码
由于自注意力机制本身是置换不变的（即不感知序列顺序），Transformer 需要额外注入位置信息。原始论文采用了基于正弦和余弦函数的位置编码（Sinusoidal Positional Encoding），后续工作如 BERT 则使用了可学习的位置嵌入。位置编码使得模型能够区分不同位置的相同 token。

第 5 章 编码器-解码器结构
Transformer 采用经典的编码器-解码器（Encoder-Decoder）架构。编码器由多个相同的层堆叠而成，每层包含多头自注意力和前馈神经网络。解码器类似，但在自注意力之上增加了一个编码器-解码器注意力层，用于关注编码器的输出。

第 6 章 应用与影响
Transformer 架构已被广泛应用于各种 NLP 任务，包括机器翻译、文本摘要、问答系统等。基于 Transformer 的大规模预训练模型（如 BERT、GPT 系列、T5）进一步推动了自然语言处理的发展，甚至在计算机视觉、语音识别等领域也取得了显著成果。可以说，Transformer 是过去十年人工智能领域最重要的架构创新之一。

第 7 章 局限与未来
尽管 Transformer 取得了巨大成功，但仍存在一些局限性。首先，自注意力的计算复杂度是序列长度的平方级，这在处理超长序列时成为瓶颈。其次，模型参数量巨大，训练和推理成本高昂。未来的研究方向包括稀疏注意力、线性注意力、长上下文建模等。"""

MOCK_AI_RESPONSE = """基于这篇关于 Transformer 的综述文档，让我解释你选中的这段话。

**段落位置与作用**
你选中的这段话出现在第 1 章（引言），是整个文档的开篇导引段落。它承担着为读者建立 Transformer 整体认知框架的任务——交代历史背景、点出核心创新（《Attention Is All You Need》论文）、并预告全文的论述主线。

**核心意思拆解**

文档作者在这段话里传递了三个层次的信息：

1. **背景铺垫**：先肯定了"深度学习在 NLP 取得突破"这个大前提，让读者意识到这是一个值得讨论的话题
2. **历史定位**：明确指出 Transformer 的源头——Vaswani 等人 2017 年的论文，并把这次创新定义为"范式转变"
3. **篇章预告**："本章将介绍…"这句暗示了接下来的章节安排，为读者构建阅读预期

**与文档其他部分的关联**

这段开篇导引与第 7 章（局限与未来）形成首尾呼应：
- 第 1 章强调"突破性进展"
- 第 7 章则冷静指出"计算复杂度是序列长度的平方级""参数量巨大"等局限

这种"高调引入 → 冷静审视"的结构是学术综述的典型写法。

**补充一句**
如果你读完整篇文档会发现，作者对 Transformer 的态度是**既肯定又审慎**——这是高质量综述的特征。"""


# ===== Mock DeepSeek server =====
class MockHandler(BaseHTTPRequestHandler):
    captured_prompts = []  # 类变量记录所有接收到的 prompt

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        try:
            data = json.loads(body)
        except Exception:
            data = {}
        if "/chat/completions" not in self.path:
            self.send_response(404)
            self.end_headers()
            return

        # 记录 prompt
        user_msg = data.get("messages", [{}])[0].get("content", "")
        MockHandler.captured_prompts.append(user_msg)

        # 流式返回 mock 答案
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.close_connection = True

        tokens = MOCK_AI_RESPONSE.split("\n")
        for tk in tokens:
            chunk = {
                "id": "mock-2",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": data.get("model", "deepseek-chat"),
                "choices": [{"index": 0, "delta": {"content": tk + "\n"}, "finish_reason": None}],
            }
            line = f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            self.wfile.write(line.encode("utf-8"))
            self.wfile.flush()
            time.sleep(0.04)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "*")
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def shot(page, name):
    path = SCREENSHOT_DIR / f"{name}.png"
    page.screenshot(path=str(path))
    print(f"  shot: {path.name}")
    return path


def main():
    subprocess.run(["rm", "-rf", PROFILE_DIR], check=False)

    print("[0] 启动 mock DeepSeek server...")
    MockHandler.captured_prompts = []
    server = ThreadedHTTPServer(("127.0.0.1", 18766), MockHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
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
            deadline = time.time() + 30
            while time.time() < deadline:
                if ctx.service_workers:
                    sw = ctx.service_workers[0]
                    break
                time.sleep(0.5)
            if not sw:
                # SW 需要先访问 chrome://extensions 才能激活
                page0 = ctx.new_page()
                page0.goto("chrome://extensions/")
                time.sleep(2.0)
                deadline = time.time() + 30
                while time.time() < deadline:
                    if ctx.service_workers:
                        sw = ctx.service_workers[0]
                        break
                    time.sleep(0.5)
                page0.close()
            if not sw:
                print("  FAIL: service worker not up")
                return
            m = re.search(r"chrome-extension://([a-z]+)/", sw.url)
            ext_id = m.group(1)
            print(f"  ext id: {ext_id}")

            options_url = f"chrome-extension://{ext_id}/src/options/options.html"
            sidepanel_url = f"chrome-extension://{ext_id}/src/sidepanel/sidepanel.html"

            # ---- 配置 deepseek 指向 mock ----
            print("[3] 配置 deepseek endpoint 指向 mock...")
            page = ctx.new_page()
            page.goto(options_url, wait_until="domcontentloaded")
            page.wait_for_selector(".agent-item", timeout=10000)
            page.evaluate(
                """async (ep) => {
                    let cfg = await chrome.storage.sync.get(['agents', 'defaultAgent']);
                    if (!cfg.agents) cfg.agents = {};
                    if (!cfg.agents.deepseek) {
                        cfg.agents.deepseek = {
                            label: 'DeepSeek',
                            endpoint: ep,
                            model: 'deepseek-chat',
                            apiKey: 'mock-key',
                        };
                    } else {
                        cfg.agents.deepseek.endpoint = ep;
                        cfg.agents.deepseek.apiKey = 'mock-key';
                    }
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
            shot(page, "v2-01-options")

            # ---- 打开 sidepanel ----
            print("[4] 打开 sidepanel，注入 context + 全文...")
            page.goto(sidepanel_url, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")

            pdf_url = "file:///tmp/test-paper-v2.pdf"
            pages = MOCK_PDF_TEXT.split("\n\n--- Page Break ---\n\n")

            # 用 djb2 算 hash（跟 background 一致）
            page.evaluate(
                """async (data) => {
                    function djb2(s) {
                        let h = 5381;
                        for (let i = 0; i < s.length; i++) {
                            h = ((h << 5) + h + s.charCodeAt(i)) | 0;
                        }
                        return 'h' + (h >>> 0).toString(16).padStart(8, '0');
                    }
                    const key = djb2(data.pdfUrl);
                    await chrome.storage.session.set({
                        ['pdf:' + key]: {
                            fullText: data.fullText,
                            numPages: 7,
                            pages: data.pages,
                            url: data.pdfUrl,
                            ts: Date.now(),
                        },
                        pendingPrompt: {
                            text: data.selectedText,
                            agent: 'deepseek',
                            pdfUrl: data.pdfUrl,
                            hasFullText: true,
                            pdfNumPages: 7,
                            pdfChars: data.fullText.length,
                        },
                        selection: data.selectedText,
                        selectionUrl: data.pdfUrl,
                    });
                    return key;
                }""",
                {
                    "pdfUrl": pdf_url,
                    "fullText": MOCK_PDF_TEXT,
                    "pages": pages,
                    "selectedText": "Transformer 架构由 Vaswani 等人在 2017 年的论文《Attention Is All You Need》中首次提出，彻底改变了序列建模的范式。",
                },
            )

            page.reload(wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle")
            time.sleep(2.0)
            shot(page, "v2-02-sidepanel-loaded")

            # 验证 UI 状态
            status = page.evaluate(
                """() => {
                    const el = document.getElementById('full-doc-status');
                    return { text: el.innerText, className: el.className };
                }"""
            )
            print(f"  全文状态: {status}")

            # ---- 用户输入问题 ----
            print("[5] 输入问题并发送...")
            page.locator("#user-input").fill(
                "选中的这段话在文档的什么位置？它的作用是什么？"
            )
            time.sleep(0.3)
            shot(page, "v2-03-question-typed")
            page.locator("#send-btn").click()

            # 等流式完成
            page.wait_for_function(
                """() => {
                    const bs = document.querySelectorAll('.msg.assistant .bubble');
                    return bs.length >= 1 && bs[bs.length-1].innerText.length > 200;
                }""",
                timeout=20000,
            )
            time.sleep(2.5)
            # 滚动到顶部让 user 问题可见
            page.evaluate("() => { document.getElementById('chat').scrollTop = 0; }")
            time.sleep(0.5)
            shot(page, "v2-04-streaming-complete")

            # 检查 chat 内容
            chat_info = page.evaluate(
                """() => {
                    const msgs = document.querySelectorAll('.msg');
                    return Array.from(msgs).map(m => ({
                        role: m.classList.contains('user') ? 'user' : 'assistant',
                        text: m.innerText.substring(0, 50),
                        rect: m.getBoundingClientRect().top,
                    }));
                }"""
            )
            print(f"  Chat messages ({len(chat_info)}):")
            for m in chat_info:
                print(f"    [{m['role']}] top={m['rect']:.0f}: {m['text']}")

            # ---- 验证 mock 收到的 prompt ----
            print("[6] 验证 mock 收到的 prompt...")
            assert MockHandler.captured_prompts, "mock 没收到 prompt！"
            prompt = MockHandler.captured_prompts[-1]
            print(f"  prompt 长度: {len(prompt)}")
            print(f"  包含'文档全文' 标记: {'【文档全文】' in prompt}")
            print(f"  包含'我选中的内容' 标记: {'【我选中的内容】' in prompt}")
            print(f"  包含 'Transformer 架构由 Vaswani': {'Transformer 架构由 Vaswani' in prompt}")
            print(f"  包含 '第 5 章 编码器': {'第 5 章 编码器' in prompt}")
            print(f"  包含用户问题: {'选中的这段话在文档的什么位置' in prompt}")
            # 显示 prompt 前 300 字符
            print(f"\n  Prompt 前 300 字符:")
            print("  " + prompt[:300].replace("\n", "\n  "))

            # ---- 多轮 ----
            print("\n[7] 多轮对话...")
            page.locator("#user-input").fill("第 7 章讲了什么？")
            time.sleep(0.3)
            page.locator("#send-btn").click()
            page.wait_for_function(
                """() => {
                    const bs = document.querySelectorAll('.msg.assistant .bubble');
                    return bs.length >= 2 && bs[bs.length-1].innerText.length > 50;
                }""",
                timeout=15000,
            )
            time.sleep(0.5)
            page.evaluate(
                """() => {
                    const bs = document.querySelectorAll('.msg.assistant .bubble');
                    bs[bs.length-1].scrollIntoView({ block: 'center' });
                }"""
            )
            time.sleep(0.3)
            shot(page, "v2-05-multi-turn")

            msg_count = page.evaluate("() => document.querySelectorAll('.msg').length")
            print(f"  消息总数: {msg_count}")

            ctx.close()
            print("\n[完成]")
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()