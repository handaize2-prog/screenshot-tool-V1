# Module Screenshot Tool

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/handaize2-prog/screenshot-tool-V1)

一个本地网页工具，用来把 HTML 页面按模块截图。

它会用本机 Chrome 打开网页，按照 H5 手机宽度渲染，再把每个模块导出为 PNG 图片。

## 功能

- 自动读取工作目录中的 `.html` 文件
- 支持在线上传 `.html` 文件
- 自动识别 `section` 和 `footer` 模块
- 支持手动输入 CSS 选择器，例如 `#team`、`.pricing-inquiry`
- 默认按 `430px` H5 宽度渲染
- 默认导出 `1420px` 宽 PNG 图片
- 截图文件自动保存到工作目录下的新文件夹，并提供下载链接

## 环境要求

- Windows
- Node.js 18+
- Google Chrome

默认 Chrome 路径：

```text
C:\Program Files\Google\Chrome\Application\chrome.exe
```

## 使用方法

本地运行：

```powershell
npm start
```

打开浏览器访问：

```text
http://127.0.0.1:8030
```

## 工作目录

默认情况下，工具会读取它上一级目录里的 HTML 文件。
在线部署后，建议直接在页面中上传 HTML 文件。

如果你想指定其他目录，可以设置环境变量：

```powershell
$env:WORKSPACE_DIR="C:\你的网页目录"
npm start
```

## 部署到 Render

本项目已包含 `Dockerfile` 和 `render.yaml`。

部署步骤：

1. 打开 Render。
2. New + 选择 Blueprint 或 Web Service。
3. 连接本仓库。
4. Render 会使用 Docker 构建服务。
5. 部署完成后打开 Render 提供的网址即可使用。

Docker 环境会自动安装 Chromium，并通过下面的环境变量调用：

```text
CHROME_PATH=/usr/bin/chromium
CHROME_NO_SANDBOX=1
WORKSPACE_DIR=/app/data
```

## 截图参数

页面里可以设置：

- H5 渲染宽度：默认 `430`
- 导出图片宽度：默认 `1420`

例如渲染宽度 `430`、导出宽度 `1420`，图片会保持比例放大，不改变页面布局。

## 常见选择器

```text
section.hero
#team
#experience
.pricing-inquiry
footer.footer
```

## 注意

这是本地工具，不会上传网页内容到互联网。截图生成在你的电脑本地目录中。
