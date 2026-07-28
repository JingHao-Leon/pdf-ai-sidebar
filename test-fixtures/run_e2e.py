"""端到端测试 PDF AI Sidebar 扩展。

流程：
1. 启动持久 Chrome，加载扩展
2. 读取 DeepSeek API key，注入到 options 页
3. 截图 options 页（证明配置已就位）
4. 打开测试 PDF（Chrome 原生 PDF viewer）
5. 框选一段文字 → 触发右键菜单
6. 截图右键菜单（证明 AI 子菜单可见）
7. 直接打开 sidepanel.html 验证 UI 渲染
8. 截图 sidepanel
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# ============== 路径 ==============
PROJECT = Path("/Users/ahs/Documents/一坨/pdf-ai-sidebar")
PDF_PATH = PROJECT / "test-fixtures" / "test-paper.pdf"
PROFILE_DIR = "/tmp/pdf-ai-test-profile"
SCREENSHOT_DIR = PROJECT / "test-fixtures" / "screenshots"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

CHROME = "/Users/ahs/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

# ============== 读 DeepSeek key（绝不打印） ==============
def load_deepseek_config():
    cfg = {}
    with open("/Users/ahs/.mavis/secrets/.deepseek.env") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip('"').strip("'")
    api_key = cfg.get("DEEPSEEK_API_KEY", "")
    model = cfg.get("DEEPSEEK_MODEL", "deepseek-chat")
    base_url = cfg.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    # key 校验
    if not api_key.startswith("sk-"):
        raise RuntimeError(f"DEEPSEEK_API_KEY 格式异常: {api_key[:4]}...")
    return api_key, model, base_url


def shot(page, name: str):
    path = SCREENSHOT_DIR / f"{name}.png"
    page.screenshot(path=str(path), full_page=False)
    print(f"  📸 {path}")
    return path


def main():
    # 清空 profile 重新开始（避免上次测试残留）
    subprocess.run(["rm", "-rf", PROFILE_DIR], check=False)

    api_key, model, base_url = load_deepseek_config()
    print(f"✓ 读取 DeepSeek 配置: model={model}, key 前缀 {api_key[:4]}, base_url={base_url}")
    print(f"  key 长度: {len(api_key)} 字符（已隐藏明文）")

    with sync_playwright() as p:
        # 启动持久 Chrome，加载扩展
        # headed 模式才能加载扩展（headless 模式无法加载 unpacked extension）
        print("\n[1/7] 启动 Chrome + 加载扩展…")
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            executable_path=CHROME,
            headless=False,
            args=[
                f"--load-extension={PROJECT}",
                f"--disable-extensions-except={PROJECT}",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-features=TranslateUI",
                "--disable-blink-features=AutomationControlled",
                "--window-size=1280,800",
                "--window-position=100,100",
            ],
            viewport={"width": 1280, "height": 800},
            accept_downloads=False,
        )

        # 等待扩展 service worker 起来
        print("[2/7] 等待扩展 service worker…")
        sw = None
        for i in range(30):
            workers = ctx.service_workers
            if workers:
                sw = workers[0]
                break
            time.sleep(0.5)
        if not sw:
            print("  ❌ service worker 未启动")
            ctx.close()
            sys.exit(1)
        print(f"  ✓ service worker url: {sw.url}")

        # 从 sw.url 提取扩展 ID
        # 格式: chrome-extension://abcdefghijk/...
        m = re.search(r"chrome-extension://([a-z]+)/", sw.url)
        if not m:
            print(f"  ❌ 无法从 sw.url 提取扩展 ID: {sw.url}")
            ctx.close()
            sys.exit(1)
        ext_id = m.group(1)
        print(f"  ✓ 扩展 ID: {ext_id}")

        options_url = f"chrome-extension://{ext_id}/src/options/options.html"
        sidepanel_url = f"chrome-extension://{ext_id}/src/sidepanel/sidepanel.html"

        # ----- 打开 options 页，填 key -----
        print("\n[3/7] 打开 options 页，配置 DeepSeek…")
        page = ctx.new_page()
        page.goto(options_url, wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")

        # 等待 agent list 渲染
        page.wait_for_selector(".agent-item", timeout=10000)
        print("  ✓ options 页加载完成")

        # 找到 deepseek agent 的 apiKey input 并填入
        # deepseek agent 的 ID 是 'deepseek'（小写）
        ok = page.evaluate(
            """(apiKey) => {
                const items = document.querySelectorAll('.agent-item');
                for (const item of items) {
                    const id = item.dataset.id;
                    if (id === 'deepseek') {
                        const input = item.querySelector('[data-f="apiKey"]');
                        if (!input) return 'no-input';
                        input.focus();
                        // 用原生 setter 避免 React 同步问题（这里不是 React，直接赋值也行）
                        input.value = apiKey;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        // 确保 password type 不被切换显示（这里就是 password）
                        return 'ok';
                    }
                }
                return 'not-found';
            }""",
            api_key,
        )
        print(f"  ✓ 填入 deepseek key: {ok}")

        # 等保存状态显示
        time.sleep(1.0)
        shot(page, "01-options-configured")

        # ----- 打开测试 PDF -----
        print("\n[4/7] 打开测试 PDF…")
        page.goto(f"file://{PDF_PATH}", wait_until="domcontentloaded")
        time.sleep(2.5)  # 等 PDF 渲染

        # 检查是否进入 PDF viewer（chrome:// 内部页面）
        url_now = page.url
        print(f"  当前 URL: {url_now[:80]}...")
        # Chrome 原生 PDF viewer 的 title 是 PDF 文件名
        title = page.title()
        print(f"  页面标题: {title}")
        shot(page, "02-pdf-opened")

        # ----- 框选一段文字 -----
        print("\n[5/7] 在 PDF 中框选一段文字…")
        # PDF viewer 的 viewport 大概从顶部 toolbar 下面开始
        # 用 viewport 中心偏上的位置模拟框选一段
        viewport = page.viewport_size
        cx, cy = viewport["width"] // 2, viewport["height"] // 2 + 30

        # 先确保没有任何选区
        page.mouse.click(cx, cy + 200)
        time.sleep(0.3)

        # 拖拽框选（从左上到右下）
        sx, sy = cx - 280, cy - 60
        ex, ey = cx + 280, cy + 30
        page.mouse.move(sx, sy)
        page.mouse.down()
        # 多步拖动更像真实操作
        steps = 12
        for i in range(1, steps + 1):
            page.mouse.move(
                sx + (ex - sx) * i / steps,
                sy + (ey - sy) * i / steps,
            )
            time.sleep(0.02)
        page.mouse.up()
        time.sleep(0.5)
        print(f"  ✓ 已框选区域 ({sx},{sy}) → ({ex},{ey})")
        shot(page, "03-pdf-text-selected")

        # ----- 触发右键菜单 -----
        print("\n[6/7] 触发右键菜单…")
        page.mouse.click(cx, cy, button="right")
        time.sleep(0.6)
        shot(page, "04-context-menu")

        # 检查右键菜单是否包含 "PDF AI 提问"
        # Chrome 右键菜单是浏览器原生 UI，无法用 DOM 检查
        # 但从截图能看出来

        # ----- 关闭右键菜单，点空白处 -----
        page.keyboard.press("Escape")
        time.sleep(0.3)

        # ----- 单独打开 sidepanel.html 验证 UI -----
        print("\n[7/7] 验证 sidepanel UI…")
        page.goto(sidepanel_url, wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")
        time.sleep(1.0)
        shot(page, "05-sidepanel-initial")

        # 模拟一个 pendingPrompt + selection 注入（直接操作 storage）
        print("  注入模拟数据（context text）…")
        page.evaluate(
            """() => {
                return new Promise((resolve) => {
                    chrome.storage.session.set({
                        pendingPrompt: {
                            text: 'Transformer 是一种基于自注意力机制的神经网络架构，由 Vaswani 等人在 2017 年的论文《Attention Is All You Need》中提出。它彻底改变了自然语言处理领域，并在计算机视觉、语音识别等多个领域取得了突破性进展。',
                            agent: 'deepseek',
                            defaultQuestion: '请用通俗易懂的语言解释这段话',
                        },
                        selection: 'Transformer 是一种基于自注意力机制的神经网络架构',
                        selectionUrl: 'file:///test.pdf',
                    }, () => resolve(true));
                });
            }"""
        )
        time.sleep(0.5)
        # 重新初始化 sidepanel（重新触发 init）
        page.reload(wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")
        time.sleep(1.5)
        shot(page, "06-sidepanel-with-context")

        # 截一个聊天界面（手动注入一条对话历史）
        page.evaluate(
            """() => {
                return new Promise((resolve) => {
                    chrome.storage.session.set({
                        chatHistory: [
                            { role: 'user', content: '这段话主要讲了什么？' },
                            { role: 'assistant', content: '这段话介绍了 Transformer 架构的核心概念：**自注意力机制**。\n\n要点：\n- 由 Vaswani 等人在 2017 年提出\n- 原始论文《Attention Is All You Need》\n- 最初用于 NLP，现在已扩展到 CV、语音等多个领域' },
                        ],
                    }, () => resolve(true));
                });
            }"""
        )
        page.reload(wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")
        time.sleep(1.5)
        shot(page, "07-sidepanel-with-chat")

        print("\n✅ 所有截图完成，存放于:")
        print(f"   {SCREENSHOT_DIR}")

        ctx.close()
        print("\n[完成] Chrome 已关闭")


if __name__ == "__main__":
    main()