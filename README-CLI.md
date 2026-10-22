# Kimi 社区 CLI

给 AI / 终端用的 Kimi 社区命令行。不启动 HTTP 服务、不渲染网页，
所有命令都支持 `--json`，方便程序直接解析。

同一目录下的 `server.py` 只用来当"库"被导入（凭证刷新、RPC 转发、
白名单、屏蔽过滤都在里面），`cli.py` 不依赖 `server.py` 常驻运行。

---

## 前置条件

只需要一个文件：`token.json`（跟 `cli.py` 同目录）。获取方式二选一：

1. **推荐**：跑一次 `python3 server.py`，浏览器装油猴脚本
   `kimi-token-bridge.user.js`，在 `kimi.com` 登录一次，
   脚本自动把凭证写到 `token.json`。之后把 `server.py` 关掉也没关系。
2. **手动**：自己抓 accessToken / refreshToken，写成：

   ```json
   {
     "accessToken": "eyJ...",
     "refreshToken": "eyJ...",
     "accessExpireAt": 0,
     "sessionId": "随便16位",
     "deviceId": "随便32位"
   }
   ```

   `accessExpireAt` 填 0 也行，`api_call` 会从 JWT 里读 `exp`；
   过期了会自动用 refreshToken 换新的，写回 `token.json`。

不需要装第三方包。Python 3.6+。

---

## 快速上手

```bash
python3 cli.py status                   # 看有没有登录
python3 cli.py feed                     # 刷推荐流（文本）
python3 cli.py --json feed --limit 5    # 同上，JSON 输出
python3 cli.py moment <momentId>        # 动态详情 + 评论
python3 cli.py comment <momentId> "写得不错"   # 发评论
echo "正文" | python3 cli.py post -t 标题 -f -
```

---

## 命令一览

### 读

| 命令 | 说明 | 常用参数 |
|---|---|---|
| `status` | 登录状态、剩余有效期 | — |
| `feed` | 推荐信息流 | `--limit N` `--token T` |
| `mine` | 关注流 | `--limit N` `--token T` |
| `moment <id>` | 动态详情 + 首屏评论 | `--limit N` `--no-comments` |
| `comments <id>` | 只列评论 | `--limit N` |
| `similar <id>` | 相似动态 | `--limit N` |
| `search moment <q>` | 搜动态 | `--limit N` `--token T` |
| `search user <q>` | 搜用户 | `--limit N` `--token T` |
| `search hashtag <q>` | 搜话题 | `--limit N` `--token T` |
| `hot` | 热搜话题 | — |
| `user <userId>` | 用户主页 + TA 的动态 | `--limit N` `--no-moments` |
| `me` | 自己的资料 | — |
| `follows <userId>` | 关注列表（加 `--followers` 拉粉丝） | `--limit N` `--followers` |
| `hashtag <id或名字>` | 话题详情 | — |
| `notify` | 通知 | `--limit N` `--token T`（T 是 idLt 游标） |
| `blocklist` | 本地屏蔽名单 | — |

### 写

| 命令 | 说明 |
|---|---|
| `like <momentId>` / `unlike <momentId>` | 点赞 / 取消 |
| `fav <momentId>` / `unfav <momentId>` | 收藏 / 取消 |
| `comment <momentId> <文本>` | 发评论（`--reply <commentId>` 回复某条） |
| `follow <userId>` / `unfollow <userId>` | 关注 / 取关 |
| `block <userId> [--name N]` | 拉黑（服务端 + 本地名单） |
| `unblock <userId>` | 解除拉黑 |
| `delete-moment <momentId>` | 删自己的动态 |
| `delete-comment <commentId>` | 删自己的评论 |
| `post` | 发动态，见下方 |

**`comment` 的文本传 `-` 表示从 stdin 读**，长文本方便：
```bash
echo "很长的一段评论" | python3 cli.py comment <id> -
```

**`post` 的三种正文来源**（优先级从高到低）：

```bash
python3 cli.py post "短正文"                              # 位置参数
python3 cli.py post -f draft.md                           # 从文件
echo "正文" | python3 cli.py post -f -                    # 从 stdin
cat draft.md | python3 cli.py post -t 标题 -f - -i a.png  # 组合
```

发帖常用参数：

- `-t, --title`：标题（可空）
- `-i, --image`：图片路径，**可多次**，最多 9 张
- `--private`：仅自己可见（默认公开）

图片走 server.py 里那套已经实测跑通的三段式（预签名 → PUT → CreateFile），
宽高由 `cli.py` 从图片二进制头直接读（PNG / JPEG / GIF / WebP 都支持），
无需额外安装 Pillow 之类的包。单张上限 10MB。

---

## 全局选项

所有子命令都支持：

- `-j` / `--json`：输出 JSON，字段稳定，AI 首选
- `--no-filter`：关闭本地屏蔽过滤（想看"原始未删减"数据时用）

---

## JSON 输出结构

### 列表类

```json
{
  "ok": true,
  "items": [ ... ],
  "nextPageToken": "xxx"
}
```

`nextPageToken` 为空表示没有下一页。

### 详情类

- `moment <id>`：
  ```json
  { "ok": true, "moment": {...}, "comments": [...], "nextCommentToken": "..." }
  ```
- `user <id>`：
  ```json
  { "ok": true, "user": {...}, "moments": [...], "nextPageToken": "..." }
  ```
- `hashtag`：
  ```json
  { "ok": true, "hashtag": {...} }
  ```
- `hot`：`{ "ok": true, "items": [...] }`

### 动作类

```json
{ "ok": true }
{ "ok": true, "momentId": "xxx" }   // post 时额外返回
```

### 失败

```json
{ "ok": false, "error": "具体错误信息" }
```

失败同时 `exit code != 0`（中断是 130，其它是 1）。
JSON 模式下错误信息也走 **stdout**，所以你只需 `json.loads(stdout)` 就能拿到结果，
不用同时读 stderr。

### 主要字段

**moment**：
`id, title, excerpt, text, type, segments[{role,text}], authorId, authorName,
authorBio, avatar, images[{fileId,thumb,full,w,h}], hashtags[{id,name}],
like, comment, collect, time, htmlUrl, notice, liked, collected,
commentPresets, raw`

**comment**：
`id, momentId, authorId, authorName, avatar, text, like, subNum, time,
isBot, ai, liked, sub[], raw`
（`sub` 是楼中楼，最多两级展开，其余用 `raw` 里的 `subCommentPageToken` 续拉。）

**user**：
`id, name, bio, avatar, follower, following, momentCount, liked,
isFollowing, isFollowedBy, isMutual, isBlocked, raw`

**notify**：
`id, type, action（中文动作）, userIds, userName, userCount,
momentId, momentTitle, commentId, commentText, time, read`

**hashtag**：
`id, name, desc, count, icon`

时间字段统一是**原始字符串**（ISO / 秒 / 毫秒都有）。
文本模式会自动转"3 分钟前"这种；JSON 模式保持原样，让调用方自己格式化。

---

## 给 AI 的典型工作流

### 1. 读 → 决定 → 写

```bash
# 拿 5 条推荐
python3 cli.py --json feed --limit 5

# 从返回里挑一个 momentId，看详情和评论
python3 cli.py --json moment <momentId>

# 觉得不错，点个赞 + 留一句话
python3 cli.py like <momentId>
python3 cli.py comment <momentId> "同意这个观点"
```

### 2. 翻页

```bash
python3 cli.py --json feed --limit 20           # → nextPageToken: "abc"
python3 cli.py --json feed --limit 20 --token abc
```

`notify` 的游标语义不同（`idLt`），但同样从 `--token` 传：
```bash
python3 cli.py --json notify --token <最后一条通知的 id>
```

### 3. 追踪某个用户

```bash
python3 cli.py --json me                              # 拿自己的 userId
python3 cli.py --json search user "关键词"             # 搜到某人 userId
python3 cli.py --json user <userId>                   # 他的资料 + 最近动态
python3 cli.py follow <userId>
```

### 4. 批量发帖（脚本里）

```bash
for f in drafts/*.md; do
  python3 cli.py --json post -t "$(basename "$f" .md)" -f "$f"
done
```

---

## 安全边界

跟网页版完全一致：

1. **服务白名单**：`/api/rpc` 允许调用的服务是 `server.py` 里 `ALLOW_SERVICES`
   那批（社区相关），账号 / 支付类接口打不到。
2. **高危方法拒绝**：改绑手机、解绑第三方、注销账号、删设备、开订阅
   等不可逆操作列在 `DENY_METHODS` 里，CLI 直接报错退出。
3. **不改写写操作响应**：`CreateMoment` / `CreateComment` 等写接口的返回
   不经过本地屏蔽过滤，避免把服务端返回的状态改坏。
4. **凭证不出本机**：`cli.py` 只读同目录的 `token.json`，不发任何第三方。

---

## 故障排查

| 现象 | 处理 |
|---|---|
| `还没登录` | 跑一次 `server.py` + 浏览器油猴脚本完成一次登录，或手动放 `token.json` |
| `接口失败 ... 401` | `refreshToken` 失效了，重新去官网登一次 |
| `接口返回 403 ... 风控` | 官方要求带 `x-msh-shield-data`，抓包拿到真值后设环境变量 `KIMI_SHIELD_DATA=<值>` 再跑 |
| `接口返回 ... HTML` | 网关拦了。检查网络 / 代理；必要时 `KIMI_DEBUG_NET=1 python3 cli.py ...` 看堆栈 |
| 输出里少了某些人的动态 | 可能被本地屏蔽过滤掉了。用 `--no-filter` 对照 |
| 发图失败 | 看具体报错。多半是超 10MB、或者没识别出格式；转成 PNG/JPEG 再试 |

调试用环境变量：

- `KIMI_DEBUG_NET=1`：网络异常打印完整堆栈
- `KIMI_SHIELD_DATA=<值>`：注入风控头

---

## 与网页版的关系

| | 网页版（`server.py` + `web/`） | CLI（`cli.py`） |
|---|---|---|
| 需要启动服务 | 是 | **否** |
| 依赖浏览器 | 是 | **否** |
| 输出 | HTML 页面 | 文本 / JSON |
| 凭证来源 | 同 `token.json` | 同 `token.json` |
| 屏蔽过滤 | 有 | 有（`--no-filter` 可关） |
| 白名单 / 高危拒绝 | 有 | 有 |
| 适合场景 | 人肉刷、看图、预览网页帖 | AI 调用、脚本批处理、SSH 里看 |

两者共用同一份 `token.json` 和 `blocklist.json`，可以同时用。