"""生成一个测试 PDF（学术论文风格），用于浏览器扩展测试。"""
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.enums import TA_LEFT, TA_JUSTIFY
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import os

OUT = "/Users/ahs/Documents/一坨/pdf-ai-sidebar/test-fixtures"
os.makedirs(OUT, exist_ok=True)

# 注册一个支持中英文的字体（macOS 自带）
pdfmetrics.registerFont(TTFont("STHeiti", "/System/Library/Fonts/STHeiti Medium.ttc", subfontIndex=0))

doc = SimpleDocTemplate(
    os.path.join(OUT, "test-paper.pdf"),
    pagesize=A4,
    leftMargin=2 * cm,
    rightMargin=2 * cm,
    topMargin=2 * cm,
    bottomMargin=2 * cm,
)

styles = getSampleStyleSheet()
title_style = ParagraphStyle(
    "Title",
    parent=styles["Title"],
    fontName="STHeiti",
    fontSize=18,
    leading=22,
    spaceAfter=12,
    alignment=TA_LEFT,
)
author_style = ParagraphStyle(
    "Author",
    parent=styles["Normal"],
    fontName="STHeiti",
    fontSize=11,
    textColor="#666666",
    spaceAfter=20,
)
h2_style = ParagraphStyle(
    "H2",
    parent=styles["Heading2"],
    fontName="STHeiti",
    fontSize=14,
    leading=20,
    spaceBefore=14,
    spaceAfter=8,
)
body_style = ParagraphStyle(
    "Body",
    parent=styles["Normal"],
    fontName="STHeiti",
    fontSize=11,
    leading=17,
    spaceAfter=8,
    alignment=TA_JUSTIFY,
)

story = [
    Paragraph("测试论文：Transformer 架构在长文本摘要任务中的应用", title_style),
    Paragraph("Mavis · 2026", author_style),
    Paragraph("摘要", h2_style),
    Paragraph(
        "本研究探讨了 Transformer 架构在长文本摘要任务中的表现。我们对比了 BART、PEGASUS 和 T5 三种主流预训练模型在 CNN/DailyMail 和 arXiv 摘要数据集上的效果。实验结果表明，经过微调后的 PEGASUS-X 在长文档（&gt;3000 词）摘要任务上取得最佳 ROUGE-L 分数 47.3，比基线提升 5.6 个百分点。",
        body_style,
    ),
    Paragraph("1. 引言", h2_style),
    Paragraph(
        "近年来，基于 Transformer 的预训练语言模型在自然语言处理领域取得了显著进展。然而，将这些模型应用于长文档摘要仍面临诸多挑战，包括计算复杂度高、位置编码长度受限、以及长程依赖建模困难等问题。本文针对这些挑战，提出了一种基于稀疏注意力机制的扩展方案。",
        body_style,
    ),
    Paragraph(
        "我们的核心贡献包括三点：第一，设计了一种结合局部窗口注意力与全局锚点注意力的混合机制；第二，提出了基于文档结构的层次化编码策略；第三，在多个公开数据集上验证了方案的有效性。",
        body_style,
    ),
    Paragraph("2. 方法", h2_style),
    Paragraph(
        "我们采用的分块策略将长文档切分为若干个长度不超过 512 的片段，每个片段独立编码后在段间通过轻量级的 Transformer 层交换信息。这种设计在保留局部上下文建模能力的同时，显著降低了显存占用。",
        body_style,
    ),
    Paragraph(
        "在解码阶段，我们引入了一种基于关键句抽取的引导机制：首先用一个轻量级分类器从源文档中识别关键句，然后在解码时通过 cross-attention bias 引导模型关注这些关键句。",
        body_style,
    ),
    Paragraph("3. 实验结果", h2_style),
    Paragraph(
        "我们在 CNN/DailyMail、arXiv、PubMed 三个数据集上进行了对比实验。结果显示，本方法在不显著增加推理时间的前提下，ROUGE-1、ROUGE-2、ROUGE-L 三个指标分别提升了 3.2、2.1、5.6 个百分点。",
        body_style,
    ),
    Paragraph(
        "消融实验进一步验证了稀疏注意力机制和层次化编码各自对最终性能的贡献。",
        body_style,
    ),
    PageBreak(),
    Paragraph("4. 讨论", h2_style),
    Paragraph(
        "尽管本方法在长文档摘要任务上取得了显著效果，但仍存在一些局限性。首先，对超长文档（&gt;10000 词）的处理仍有改进空间；其次，分块策略可能导致段间信息丢失；最后，模型的部署成本相对较高。",
        body_style,
    ),
    Paragraph(
        "未来的工作可以从以下几个方向展开：探索更高效的分块策略、研究基于强化学习的段落选择方法、以及将本方法扩展到多模态摘要任务。",
        body_style,
    ),
    Paragraph("5. 结论", h2_style),
    Paragraph(
        "本文提出了一种基于稀疏注意力与层次化编码的长文档摘要方法。实验结果验证了该方法的有效性。我们相信，这一方法为长文档理解任务提供了新的思路。",
        body_style,
    ),
]

doc.build(story)
print("wrote", os.path.join(OUT, "test-paper.pdf"))
print("size:", os.path.getsize(os.path.join(OUT, "test-paper.pdf")), "bytes")