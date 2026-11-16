# site

Hue Agent 的产品首页。单文件静态页，没有构建步骤，也不依赖 npm 包。

## 预览

直接用浏览器打开 `index.html`，或者在这个目录起一个静态服务：

```sh
cd site
python3 -m http.server 4173
# 打开 http://localhost:4173
```

## 页面结构

- 首屏：色环 logo、标题「几种色相，无数种 Agent。」、pnpm / npm / bun / yarn 四个 tab 的全局安装命令（点选切换，可复制），右边是 13 层线描图（灰线，按层轮流亮起该层色相，鼠标停留时固定在那一层；开启「减少动态效果」时不轮换）。
- 终端演示：仿 Claude Code / devin-cli 的启动样式，紧凑排版，包含顶部环境信息、子 agent 演示和底部用量状态栏。
- 「每一层，都能换」：`@hue/core` 作为接口层放在最下面，其余 12 个包按 4×3 卡片排开；点选每层的实现，下方配方代码跟着切换。
- 命令与快捷键、安装和底部 CTA。

## 设计约定

- 最深的底色是 neutral-900（`#171717`），不用纯黑。
- 卡片和正文用中性灰，色相只出现在 logo、标题里的「色相」两个字，以及当前亮起或被选中的那一层。
- 色相只用橙、金、绿、青、天蓝，不用粉色和紫色。
- 页面上不写开发过程、提示性文字、tag 或 tooltip。
- 品牌写 Hue Agent，不写域名。

## 维护

页面上的命令、参数、快捷键、状态栏格式和代码示例是按 `main` 的 `add4d9d` 对过源码写的（主要看 `hue/packages/cli/src/args.ts`、`hue/packages/cli/src/tui/interactive.ts`、`hue/packages/ai/src/info.ts` 和各包的 `src/index.ts`）。改 cli 或包的公开接口时，记得同步这里。

首屏 tab 里的 `@hue/cli` 是先写死的占位 scope：包目前都是 `private`，还没发布，这些命令现在装不上。发布后按实际包名改 `index.html` 里 `data-cmd` 和默认显示的那一条。

页面底部的安装命令目前是从源码安装（只有 npm 实测通过，bun 会把 `@hue/*` 当 registry 包去解析而失败，pnpm 和 yarn 没验证成功）：

```sh
git clone https://github.com/hifizz/hue
cd hue/hue
npm install
npm install -g ./packages/cli
```
