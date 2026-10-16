# ZReader

自用的网页版电子书阅读器，加到 iPhone 主屏幕后就像一个普通 app 一样用。
不用 Mac、不用苹果开发者账号、不花钱，也永远不会过期。

- 支持 **txt**（自动识别 UTF-8 / GBK / Big5 等编码，自动按"第X章"分章）和 **epub**
- 书架、阅读进度自动保存、目录跳转
- 字号 / 行距 / 字体 / 四种背景（纸色、护眼、灰白、夜间）
- **连续朗读**：点一下从当前位置开始读，读完自动翻章；点任意段落可从那里开始读；可调语速、选声音
- 书只保存在手机本地（浏览器的 IndexedDB），不会上传到任何地方
- 离线可用（Service Worker 缓存）

在线地址：`https://1968canghai-creator.github.io/ZReader/`

## 第一次使用（iPhone）

1. 用 **Safari** 打开上面的地址（必须是 Safari，其他浏览器不能添加到主屏幕）。
2. 点底部的「分享」按钮 → **添加到主屏幕** → 添加。
3. 以后从主屏幕的 ZReader 图标打开，全屏运行。
4. 把 txt / epub 存到 iPhone 的「文件」app 里（AirDrop、微信"用其他应用打开"、iCloud 云盘都行），然后在 ZReader 里点「导入书籍」选择它们。

## 云端书库 & 进度同步（可选）

书默认只存在导入它的那个浏览器里。想在 PC 和 iPhone 上读同一批书、接着同一个进度读，可以把书放到一个 GitHub 仓库里：

1. 在 GitHub 新建一个仓库，比如 `ZReader-books`，建议选 **Private**（私有），这样书不会被别人看到。
2. 进入仓库 → **Add file → Upload files**，把 txt / epub 拖进去，点 Commit changes（网页上传单文件上限 25 MB）。配好 Token 之后，也可以直接在 ZReader 的「书库」面板里点「上传」，不受 25 MB 限制。
3. 生成一个 Token：GitHub 头像 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token。
   - Repository access 选 **Only select repositories** → 选 `ZReader-books`
   - Permissions → Repository permissions → **Contents** 选 **Read and write**
   - 生成后复制那串 `github_pat_…`（只显示一次）
4. 在 ZReader 里点「☁ 书库」→ 填仓库名 `你的用户名/ZReader-books`，文件夹留空，粘贴 Token，勾选「同步阅读进度」→ 测试连接 → 保存。
5. 每台设备都这样填一次，之后就能从「书库」下载书，阅读进度会自动写到仓库里的 `zreader-progress.json`，换设备打开书会直接跳到上次读的位置。

公开仓库不填 Token 也能下载书，但不能同步进度。

## 朗读

- 阅读时点屏幕中间调出菜单，点「朗读」，从当前屏幕的第一段开始读。
- 朗读中点任意段落 = 从那一段开始读；面板上可以暂停、调语速、换声音。
- 想要更自然的声音：iPhone 设置 → 辅助功能 → 朗读内容 → 声音 → 中文，下载一个"增强"或"高级"音质的声音，然后在 ZReader 的「声音」里选它。
- 第一次朗读必须手动点一下（iOS 的限制），之后会一直连续读下去。锁屏会停止朗读。

## 操作说明

- 正文上 1/3 区域：上翻一屏；下 1/3 区域：下翻一屏；中间：显示 / 隐藏菜单（可在设置里改成"仅滑动"）。
- 翻到章末再点下方即进入下一章。
- 书架上的「删除」会连同阅读进度一起删掉。

## 部署 / 更新

本项目是纯静态页面，放在 GitHub Pages 上。仓库 Settings → Pages → Source 选 `Deploy from a branch`，Branch 选 `main` / `(root)`，保存后一两分钟即可访问。
之后每次 push 到 main，GitHub 会自动重新发布；手机上打开 ZReader 时若有新版本，会弹出"刷新"提示。

## 目录结构

```
index.html            页面骨架
css/style.css         样式与主题
js/app.js             书架、阅读、设置、交互
js/parsers.js         txt / epub 解析
js/tts.js             朗读引擎（speechSynthesis 封装）
js/db.js              IndexedDB 存储
sw.js                 离线缓存
manifest.webmanifest  PWA 清单
icons/                应用图标
vendor/jszip.min.js   解压 epub 用（MIT）
```

发新版本时记得把 `sw.js` 和 `js/app.js` 里的版本号一起改一下，这样手机上才会提示更新。
