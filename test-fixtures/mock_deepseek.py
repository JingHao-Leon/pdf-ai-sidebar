"""Mock DeepSeek server: 模拟 OpenAI-compatible 流式 SSE 响应。"""
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread


ANSWER = """好的，我来用通俗的语言解释这段话。

**Transformer 是什么？**

简单说，Transformer 就是一种「会读上下文」的神经网络。它和传统的循环神经网络不一样，它能**一眼看完**一整段文字，然后理解词与词之间的关系。

**为什么重要？**

打个比方：
- 老式 RNN 像一个一个字的串行阅读器，慢且容易「忘记」前面的内容
- Transformer 像一个**同时扫一行字的人**，能瞬间抓住"哪个词和哪个词有关"

**三个关键事实：**

1. **2017 年由 Google 团队提出**（论文《Attention Is All You Need》）
2. **现在统治了 AI 行业**——ChatGPT、Claude、Gemini 都是基于它
3. **应用远超 NLP**——图像、语音、蛋白质结构预测全都用它

简单总结：**Transformer 让机器第一次真正「读懂」了上下文**，这就是为什么大语言模型时代到来了。"""


class MockDeepSeekHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        # 读 body
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        # 检查路径（应该命中 /v1/chat/completions）
        if "/chat/completions" not in self.path:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error":"not found"}')
            return

        # 流式响应
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        # 不设 keep-alive，每个请求结束就关连接，避免复用混淆
        self.end_headers()
        self.close_connection = True

        # 把 ANSWER 切成 token 模拟流式
        tokens = []
        for line in ANSWER.split("\n"):
            tokens.append(line + "\n")

        for token in tokens:
            chunk = {
                "id": "mock-1",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": data.get("model", "deepseek-chat"),
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": token},
                        "finish_reason": None,
                    }
                ],
            }
            line = f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            self.wfile.write(line.encode("utf-8"))
            self.wfile.flush()
            time.sleep(0.05)  # 模拟网络延迟

        # 结束标记
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "*")
        self.end_headers()

    def log_message(self, format, *args):
        print(f"[mock] {args[0]}")


def main():
    from socketserver import ThreadingMixIn

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

    server = ThreadingHTTPServer(("127.0.0.1", 18765), MockDeepSeekHandler)
    print(f"[mock] DeepSeek mock server listening on http://127.0.0.1:18765")
    server.serve_forever()


if __name__ == "__main__":
    main()