# EchoEmby

**中文** · [English](README.en.md)

![首页](docs/images/home.png)

> 仍在开发中

---

## 功能

- 多台 Emby 服务器、账号切换
- 首页推荐、继续观看
- 详情页：分季、分集、演职员、剧照、分类、相似作品
- 片库浏览、筛选与搜索
- 播放：硬件解码（自动 / D3D11 / 软解）、字幕与音轨、首选语言、本地字幕导入（srt / ass / ssa / vtt / sub / smi / txt 与 .sup 图像字幕，特效、速度、位置都可调）、画面适配（适应屏幕 / 填满屏幕 / 拉伸填满）、Anime4K 画质增强（关闭 / 轻度 / 标准 / 高）、HDR（HDR 片源自动打开 Windows 的 HDR，看完还原）、章节、倍速、自动连播、进度条预览图（默认关闭，设置里打开）
- 弹幕：弹弹 play 官方接口，自动匹配、手动链接、屏蔽词与样式调整；接口可在设置里自定义，按顺序回退，带四步测试
- 外部评分与中文简介补强：TMDB、Rotten Tomatoes、Bangumi、Trakt 等
- 键盘操作

---

## 跑起来

需要 Windows、Node.js 20 以上，以及一台可以连上的 Emby 服务器。

```bash
npm install          # 依赖
npm run mpv          # 取 mpv.exe 到 resources/mpv（已存在则跳过）
npm run build        # 编译主进程与渲染层
npm start            # 启动
```

开发模式：

```bash
npm run dev
```

`npm run mpv` 从 GitHub Releases 拉 shinchiro 的 mpv 构建。这台机器上直连不通时，用环境变量指一条代理：

```bash
ECHOEMBY_PROXY=http://127.0.0.1:7899 npm run mpv
```

本机数据都在 `%APPDATA%\EchoEmby`：加密后的凭据、设置和元数据缓存。

---

## 技术栈

- Electron 33 无框窗口 + 自绘标题栏
- Vue 3.5 `<script setup>` + Pinia + vue-router
- TypeScript 5.7，Vite 6 编译渲染层，esbuild 编译主进程与 preload
- `contextIsolation: true`，`nodeIntegration: false`，渲染层只通过 preload 暴露的桥访问主进程
- mpv 子进程：`--wid=<HWND>` 嵌入 + 命名管道 JSON IPC，koffi 调 user32 管窗口层级
- `safeStorage`（DPAPI）加密凭据
- 主进程 `net.fetch` 是唯一的网络出口，代理设置在一处生效

```
src/
  main/        主进程：窗口、mpv 内核、Emby 客户端、元数据源、弹幕、代理、缓存
  preload/     桥
  renderer/    界面：views 页面、components 组件、stores 状态、lib 取数与格式化
  shared/      主进程与渲染层共用的类型与协议
scripts/       开发、构建、取 mpv
```

---

## 说明

- 本项目与 Emby 官方无关。
- 画质增强用的是 [Anime4K](https://github.com/bloc97/Anime4K) 的 GLSL 着色器（MIT），随应用放在 `resources/shaders/anime4k`，许可证同目录。

