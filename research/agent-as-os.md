> ## Documentation Index
> Fetch the complete documentation index at: https://agent.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 产品日记：构建生长在 Agent OS 之上的专业级 Mini App

> 从 Chatbot、工作流到 Agent，再到 Mini App，为什么我们选择让 Agent 内化为一种系统服务？

计算机系毕业之后，我在金融行业担任了 4 年分析师。

4 年 Coding + 4 年码字，让我同时站在了“造工具的人”和“重度使用工具的人”这两端。

看遍了底层算力芯片的演进，又在无数个深夜里与割裂的研报、Excel 模型和行业数据搏斗之后，我发现：在真实的专业工作中，那些稀缺、却往往在一瞬间就能做出的判断，与最终成果之间，隔着的是大量简单而繁杂的整理、排版与调优——这本是实习生都该掌握的基础技能。各行各业，或许都在等待一个真正高效的工具。

ChatGPT 破局之后，我研发过 Dify 工作流、Agentic Search，也设计过金融垂类工作台 PaiWork，深受用户喜爱。随后的实战，以及加入 MiniMax 之后的全局审视，让我收敛出一个越来越清晰的架构判断：比起 Agent，每个行业更需要一个让 Agent 与人深度协作、高度内聚的原生环境，因此 Mini App 的想法诞生了。

概括来讲，Mini App 是这样一款产品：

1. 它是一个标准的插件（Plugin），所有的能力都是可插拔的；
2. 它能够调用 Agent 和 Agent 的所有外部能力（MCP / CLI），并与 Agent 共享完整的上下文（项目与对话）；
3. 它向 Agent 暴露自身的所有能力；
4. 它拥有一套完整的前端，核心使命是让人与 AI 工作在同一个环境里。

我想从两个角度拆解 Mini App 的产品理念。

## 一、Coding Agent 作为个人工作台，为什么是错位的？

如果把现代行业工作者和程序员的工作范式放在一起对比，会看到两件事：注意力的分配高度同构，系统底座的现状却截然不同。

![同构的工作，不同的底座：程序员与现代行业工作者在工作环境、上下文分布、注意力分配上高度同构，但 Agent 依赖的系统底座截然不同](https://mintcdn.com/agent-cn/kbIez4ZkXLS5wQBk/images/techblog/agent-as-os/fig1-isomorphism.svg?fit=max\&auto=format\&n=kbIez4ZkXLS5wQBk\&q=85\&s=98f20f9fe1d87449e957eda76b0bc202)

现代行业工作者的工作环境，是各类专业软件与 SaaS 工具——芯片工程师的 EDA、工业设计师的 CAD、金融分析师的股票终端，乃至 Office。他们的上下文散落在系统的各个角落；他们 50% 以上的注意力，可能都花在理解项目、感知整体环境上，真正为“码字”而做的工作，只占不到一半；今天，已经深度使用 Coding Agent 的程序员也是如此。

但是，相同的上层结构并不能导向相同的底座。今天办公 Agent 太执著于一次性交付了，这在效率工具中其实是大忌。即使是专业的 Coding 工作，一次性编写就可以交付的项目其实极少。更何况，代码可以通过编译和脚本检查来定位缺陷，但行业中的检查只能通过人来进行。

实验室里的 AI 能解决很多问题，但每个行业真正的壁垒，恰恰在于先提出问题、再解决问题，然后再提出新问题。在“感知整体环境、提出问题”的过程中，决定走向的关键判断，往往藏在专家对全局上下文的敏锐感知里，绝不是一个黑盒式的“一句话生成”能够代劳的。

所以，我们有了 Mini App 产品理念的第一句话：

> 各行各业的真实生产力依然扎根于高度专业化的工作环境中。单纯的“Chat UI”无法替代专业工具的精准控制与复杂视图。未来的专业工作流，不应是让用户离开工作台去迁就 AI，而是让专业工作环境与 AI 深度共生。

## 二、不抢入口，我们想要将 Agent 内化为计算机的底层系统服务

在 Coding Agent 时代，成为入口的幸运儿或许已经收获了数百亿美元的 ARR；但朝着“Intelligence with Everyone”的终极目标看，程序员只是一个很小的群体。为这个极小众、且底层天然拥有统一 Bash 协议的群体打造的“入口模式”，根本无法复制到更广阔的千行百业。

行业最近的一些实践也反复证明：当你试图用一个表层的 Agent 入口接管一切，必然会摧毁原有的交互主权与生态秩序。

正因如此，我们在构建 MiniApp 时，放弃了表层“抢入口”的窄门，选择了向底层深潜的架构哲学：

![Agent as OS：人类专家掌握交互主权；MiniApp 专业工作环境同时调用 Agent OS 与传统系统服务；Agent OS 负责打通上下文、消弭协议隔阂、调度 Agent 任务与原子级推理，并依靠内存管理、线程调度、Socket 等传统系统服务；最底层是 CPU / GPU](https://mintcdn.com/agent-cn/kbIez4ZkXLS5wQBk/images/techblog/agent-as-os/fig2-agent-as-os.svg?fit=max\&auto=format\&n=kbIez4ZkXLS5wQBk\&q=85\&s=f3b734484bf90534f5ec3a26aea729bd)

如果说算力是电力，Agent 就该是操作系统。优质的 Harness 不该被做成入口，而应像内核调度、文件系统一样在底层静默运转：统一接管散落各处的上下文与工具协议，把 AI 变成专业环境随取随用的原子能力。

Agent 一旦内化为系统服务，现代计算机才真正成为高内聚的专业工作环境——插件即软件，插件即 App。**Agent 插件让你改造 Agent，MiniApp 让你在 Agent 之上做应用**。系统级的事交给宿主，开发者只写界面和业务逻辑。

更深一步，我们想清楚了 Mini App 未来要做的事：

> 通过构建生长在 Agent OS 之上的专业级 Mini Apps，我们致力于连接垂直领域的专业交互界面与底层的 AI 原生算力，重塑各行各业的工作方式。

## 相关链接

* AI 手机的一些思考：[HanZijie/agentos-android](https://github.com/HanZijie/agentos-android)
* 欢迎加入 Mini App 生态：[MiniMax-AI/MiniMax-Code-MiniApps](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/tree/main)
* 为 MiniMax Code 贡献插件：[MiniMax-AI/MiniMax-Code-Plugins](https://github.com/MiniMax-AI/MiniMax-Code-Plugins)

**一些有意思的 Mini App**

* 口水 3D 建模师必备，玩转 3D 打印只要打字：[hanzijie/cq-viewer](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/tree/main/plugins/hanzijie/cq-viewer)
* 古法编程文艺复兴工具：[trentchou/text-editor](https://github.com/TrentChou/MiniMax-Code-MiniApps/tree/add-text-editor)
* AI 帮你找到心灵归属的岛屿：[yujiachen-y/xinyu-daily](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/tree/main/plugins/yujiachen-y/xinyu-daily)
* AI Native 设计师需要一个画廊：[zch0227/anatomy-gallery](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/tree/main/plugins/zch0227/anatomy-gallery)
* 会 P 图的 Agent，和你用同一张画布：[webguhui/minimax-photo](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/tree/main/plugins/webguhui/minimax-photo)
* 多轨剪辑台上的 AI 助手，改动先预览、你点头才生效：[webguhui/minimax-video](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps/tree/main/plugins/webguhui/minimax-video)
