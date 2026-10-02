#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kimi 发现页（本地自建）— 后端服务
=================================

零依赖，只用 Python 标准库。Python 3.6+ 直接跑。

承担三件事：
  1. 托管发现页网页（http://127.0.0.1:8787）
  2. 接收油猴脚本传来的登录凭证
  3. 代理转发 Kimi 接口（浏览器有跨域限制，必须由本机转发）

安全边界：
  · 只监听 127.0.0.1，外网访问不到
  · 凭证只写本机 token.json，不上传任何地方
  · 不做任何"替你操作"的自动化

用法：
    python3 server.py
    然后浏览器打开 http://127.0.0.1:8787
"""

import json
import os
import re
import sys
import time
import uuid
import threading
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
try:
    from http.server import ThreadingHTTPServer  # Python 3.7+
except ImportError:
    ThreadingHTTPServer = HTTPServer
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE, "web")
TOKEN_FILE = os.path.join(BASE, "token.json")
BLOCK_FILE = os.path.join(BASE, "blocklist.json")

API_HOST = "https://www.kimi.com"
API_PREFIX = "apiv2"
AUTH_HOST = "https://auth.kimi.com"
AUTH_PREFIX = "api"

PORT = 8787

# 网络异常是否打印堆栈。浏览器刷新/关标签页会提前断开连接，
# 属正常现象，默认静默；想排查网络问题就把它设成 True。
DEBUG_NET = os.environ.get("KIMI_DEBUG_NET") == "1"

# 允许转发的服务白名单。
# 凭证是完整的账号凭证，万一网页被恶意脚本利用，也不该能去打账号/支付类接口。
ALLOW_SERVICES = {
    # 社区核心
    "moment.v1.FeedService",
    "moment.v1.CommentService",
    "moment.v1.MomentService",
    "moment.v1.UserService",
    "moment.v1.HashtagService",
    "moment.v1.SearchService",
    "moment.v1.NotificationService",
    "moment.v1.FavoriteService",
    "moment.v1.FollowService",
    "moment.v1.MuteService",
    "moment.v1.ComplaintService",
    "moment.v1.UploadService",
    "moment.v1.ConfigService",
    "moment.v1.InterestService",
    # 展示位 / 灵感
    "kimi.gateway.feed.v1.FeedService",
    "suggest.v1.ShowcaseService",
    "inspiration.v1.InspirationService",
    # 账号 / 用户主页（只读为主）
    "kimi.gateway.account.v1.UserService",
    # 用户设置
    "kimi.usersetting.v1.UserSettingService",
    # 存储配额 / 会员 / 设备（只读展示用）
    "kimi.gateway.storage.v1.StorageService",
    "kimi.gateway.membership.v2.MembershipService",
    "kimi.gateway.device.v1.DeviceService",
}

# 高危：即使服务在白名单里，这些具体方法也一律拒绝。
# 涉及改绑手机/解绑第三方/注销账号/改密码，一旦被利用后果不可逆。
DENY_METHODS = {
    "kimi.gateway.account.v1.SecurityService/BindPhone",
    "kimi.gateway.account.v1.SecurityService/RebindPhone",
    "kimi.gateway.account.v1.SecurityService/DeactivateAccount",
    "kimi.gateway.account.v1.SecurityService/UnbindThirdAccount",
    "kimi.gateway.account.v1.SecurityService/BindThirdAccount",
    "kimi.gateway.account.v1.SecurityService/SendVerifyCode",
    "kimi.gateway.account.v1.SecurityService/SendEmailVerifyCode",
    "kimi.gateway.account.v1.SecurityService/VerifyCurrentPhone",
    "kimi.gateway.account.v1.SecurityService/VerifyCurrentEmail",
    "kimi.gateway.device.v1.DeviceService/DeleteDevice",
    "kimi.gateway.membership.v2.MembershipService/CreateSubscription",
}

# 写操作（增删改）白名单：这些只改你自己的数据，且不得被本地过滤改写响应
WRITE_METHODS = {
    "moment.v1.CommentService/CreateComment",
    "moment.v1.CommentService/DeleteComment",
    "moment.v1.CommentService/VoteComment",
    "moment.v1.MomentService/VoteMoment",
    "moment.v1.MomentService/DeleteMoment",
    # 发文（实测测通：{title,text,visibility,images,mentions,links,hashtagIds}）
    "moment.v1.MomentService/CreateMoment",
    "moment.v1.FavoriteService/CreateFavorite",
    "moment.v1.FavoriteService/DeleteFavorite",
    "moment.v1.FollowService/ModifyFollow",
    "moment.v1.FollowService/ModifyBlock",
    "moment.v1.MuteService/Mute",
    "moment.v1.MuteService/UnMute",
    "moment.v1.MuteService/AppendMuteReasons",
    "moment.v1.ComplaintService/CreateComplaint",
    "moment.v1.NotificationService/MarkRead",
    "moment.v1.NotificationService/MarkReadForReminder",
    "moment.v1.FeedService/MarkReadForFollow",
    # 改自己的昵称/头像（用户主动）
    "kimi.gateway.account.v1.UserService/UpdateProfile",
    "kimi.usersetting.v1.UserSettingService/UpdateUserSetting",
}

# 设备伪装头：照抄官方客户端，避免被识别为异常流量
DEVICE_HEADERS = {
    "x-msh-platform": "android",
    "x-msh-os-version": "VIVO 9",
    "x-msh-device-model": "vivo vivo Z1",
    "x-msh-version": "3.1.3",
    "x-msh-app-channel": "vivo",
    "x-msh-android-version": "28",
    # 官方要求带 session-id / device-id，缺失可能被风控判定异常
    "x-msh-session-id": "1",
    "x-msh-device-id": "1",
    "x-language": "zh-CN",
    "x-msh-language": "zh-CN",
    "r-timezone": "Asia/Shanghai",
    "accept": "application/json",
    "accept-charset": "UTF-8",
    "user-agent": "ktor-client",
    "content-type": "application/json",
}

# 风控头。官方标注"必须携带，否则可能被风控拦截"。
# 这个值是客户端 SDK 生成的，本地无法真实计算，先给一个占位；
# 若你有抓包拿到的真值，用环境变量 KIMI_SHIELD_DATA 注入即可。
SHIELD_DATA = os.environ.get("KIMI_SHIELD_DATA", "")

LOCK = threading.RLock()


# ══════════════════════════════════════════
#  凭证
# ══════════════════════════════════════════
class Cred:
    def __init__(self):
        self.access = ""
        self.refresh = ""
        self.expire_at = 0
        self.session_id = uuid.uuid4().hex[:16]
        self.device_id = uuid.uuid4().hex
        self.load()

    def load(self):
        try:
            with open(TOKEN_FILE, "r", encoding="utf-8") as f:
                d = json.load(f)
            self.access = d.get("accessToken") or ""
            self.refresh = d.get("refreshToken") or ""
            self.expire_at = float(d.get("accessExpireAt") or 0)
            if d.get("sessionId"):
                self.session_id = d["sessionId"]
            if d.get("deviceId"):
                self.device_id = d["deviceId"]
            if self.access:
                print("[凭证] 已恢复，剩余 %.0f 分钟"
                      % max(0.0, (self.expire_at - time.time()) / 60))
        except FileNotFoundError:
            pass
        except Exception as e:
            print("[凭证] 读取失败：%s" % e)

    def save(self, access=None, refresh=None):
        if access is not None:
            self.access = access
        if refresh is not None:
            self.refresh = refresh
        self.expire_at = jwt_exp(self.access)
        # refresh 的有效期也要更新：服务端会滚动下发新的 refresh
        with open(TOKEN_FILE, "w", encoding="utf-8") as f:
            json.dump({
                "accessToken": self.access,
                "refreshToken": self.refresh,
                "accessExpireAt": self.expire_at,
                "refreshExpireAt": jwt_exp(self.refresh),
                "sessionId": self.session_id,
                "deviceId": self.device_id,
                "updatedAt": time.time(),
            }, f, ensure_ascii=False, indent=1)

    def valid(self):
        return bool(self.access) and self.expire_at - time.time() > 60

    def clear(self):
        self.access = self.refresh = ""
        self.expire_at = 0
        try:
            os.remove(TOKEN_FILE)
        except OSError:
            pass


def jwt_exp(token):
    """从 JWT 里读过期时间。解析失败返回 0（当作已过期，会触发刷新）。"""
    import base64
    try:
        p = token.split(".")[1]
        p += "=" * (4 - len(p) % 4)
        return float(json.loads(base64.urlsafe_b64decode(p)).get("exp", 0))
    except Exception:
        return 0.0


CRED = Cred()


def http_post(url, body, headers, timeout=20):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def http_put(url, data, content_type, timeout=60):
    """直传对象存储（presigned URL 是普通 HTTP PUT，不走 Connect-RPC）"""
    req = urllib.request.Request(url, data=data, method="PUT")
    req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def upload_image(name, raw, mime, width, height):
    """发图三步走（实测链路）：
       1) GeneratePresignedURL {fileType: FILE_TYPE_IMAGE} -> {uploadUrl, objectName, fileId}
       2) PUT 二进制到 uploadUrl（直传对象存储，浏览器做不了，有 CORS）
       3) CreateFile {fileId, fileName, extra:{width,height}} -> 可引用的文件
    """
    if not CRED.access:
        raise RuntimeError("还没登录")
    if not CRED.valid():
        do_refresh()

    # 1) 申请预签名地址
    d = api_call("moment.v1.UploadService/GeneratePresignedURL",
                 {"fileType": "FILE_TYPE_IMAGE"})
    upload_url = d.get("uploadUrl") or ""
    file_id = d.get("fileId") or ""
    if not upload_url:
        raise RuntimeError("没拿到上传地址：%s" % json.dumps(d, ensure_ascii=False)[:200])
    if not file_id:
        file_id = str(uuid.uuid4())

    # 2) 直传
    st, _ = http_put(upload_url, raw, mime or "application/octet-stream")
    # 各家对象存储成功码不同：200/201/204 都算成功
    if st not in (200, 201, 204):
        raise RuntimeError("上传到存储失败 HTTP %s" % st)

    # 3) 登记为社区文件
    created = api_call("moment.v1.UploadService/CreateFile", {
        "fileId": file_id,
        "fileName": name or "image",
        "extra": {"width": int(width or 0), "height": int(height or 0)},
    })
    return {
        "fileId": created.get("fileId") or file_id,
        "extra": {"width": int(width or 0), "height": int(height or 0)},
        "originUrl": created.get("originUrl") or "",
        "thumbnailUrl": created.get("thumbnailUrl") or "",
    }


def do_refresh():
    """用 refresh token 换新的 access token"""
    with LOCK:
        if not CRED.refresh:
            raise RuntimeError("没有 refresh token，请重新去官网取一次")
        url = "%s/%s/account.gateway.v1.AuthService/RefreshToken" % (AUTH_HOST, AUTH_PREFIX)
        h = dict(DEVICE_HEADERS)
        h.pop("authorization", None)
        status, text = http_post(url, {"refreshToken": CRED.refresh}, h)
        if status != 200:
            raise RuntimeError("刷新失败 HTTP %s：%s" % (status, text[:200]))
        d = json.loads(text)
        CRED.save(d.get("accessToken"), d.get("refreshToken") or CRED.refresh)
        print("[凭证] 已刷新，剩余 %.0f 分钟"
              % max(0.0, (CRED.expire_at - time.time()) / 60))


def api_call(method, body, retry=True):
    """转发一个 Connect-RPC 调用"""
    if not CRED.access:
        raise RuntimeError("还没登录")
    if not CRED.valid():
        do_refresh()
    url = "%s/%s/%s" % (API_HOST, API_PREFIX, method)
    h = dict(DEVICE_HEADERS)
    h["authorization"] = "Bearer " + CRED.access
    h["x-msh-session-id"] = CRED.session_id
    h["x-msh-device-id"] = CRED.device_id
    if SHIELD_DATA:
        h["x-msh-shield-data"] = SHIELD_DATA
    status, text = http_post(url, body or {}, h)
    if status == 401 and retry:
        do_refresh()
        return api_call(method, body, retry=False)
    if status != 200:
        raise RuntimeError("接口返回 %s：%s" % (status, text[:300]))
    try:
        return json.loads(text)
    except ValueError:
        raise RuntimeError("返回不是 JSON：%s" % text[:200])


# ══════════════════════════════════════════
#  屏蔽名单（服务端过滤，全页面生效）
# ══════════════════════════════════════════
def load_block():
    try:
        with open(BLOCK_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, list) else []
    except Exception:
        return []


def save_block(items):
    with open(BLOCK_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)


ID_KEYS = ("userId", "authorId", "uid", "commentUserId", "targetUserId",
           "fromUserId", "toUserId", "ownerId", "senderId", "publisherId",
           "creatorId", "blockedUserId")
NAME_KEYS = ("userName", "nickname", "nickName", "displayName",
             "authorName", "userNickname", "screenName", "name")
# 语义上明确指向"用户"的字段，不要求同层有 userId 也采信
SAFE_NAME_KEYS = ("userName", "nickname", "nickName", "displayName",
                  "authorName", "userNickname", "screenName")
# 嵌套子集合：判定某条目时不并进来，避免父条目被子条目的作者"污染"
SUB_COLLECTION_KEYS = ("subComments", "subCommentCards", "sub_comment",
                       "replies", "replyComments", "childComments")


def looks_like_id(v):
    """判断一个字符串像不像用户 ID。

    真实的 Kimi userId 形如 "d2ihd3gc86s8s00v1380"（20 位字母数字混合），
    也可能是纯数字。所以不能用 isdigit() 判断，否则真实 ID 永远匹配不上。
    """
    if not isinstance(v, str):
        return False
    s = v.strip()
    if not (4 <= len(s) <= 64):
        return False
    # 只允许字母、数字、下划线、连字符；排除含空格/中文这类明显不是 ID 的值
    return all(c.isalnum() or c in "_-" for c in s)


def scrub(node, ids, names, depth=0):
    """递归剔除被屏蔽用户的条目"""
    if depth > 8 or not isinstance(node, (dict, list)):
        return 0
    if isinstance(node, list):
        n = 0
        for i in range(len(node) - 1, -1, -1):
            it = node[i]
            if isinstance(it, (dict, list)):
                out = {"ids": set(), "names": set()}
                collect(it, out, 0)
                if out["ids"] & ids or (names and out["names"] & names):
                    node.pop(i)
                    n += 1
                    continue
            n += scrub(it, ids, names, depth + 1)
        return n
    total = 0
    for v in list(node.values()):
        total += scrub(v, ids, names, depth + 1)
    return total


def collect(node, out, depth=0):
    """收集一段数据里出现的所有用户 ID 与昵称。

    昵称只在"用户对象"里才采信——即同一个 dict 里同时存在 userId 类字段。
    否则话题名（hashtag.name）、动态标题等会被误当成用户名，
    导致按昵称屏蔽时误伤同名话题。
    """
    if depth > 6:
        return
    if isinstance(node, list):
        for v in node[:100]:
            collect(v, out, depth + 1)
        return
    if not isinstance(node, dict):
        return

    # 这一层是不是"用户对象"：含任一 ID 字段
    # 注意：真实 userId 是 "d2ihd3gc86s8s00v1380" 这种字母数字串，不能要求纯数字
    has_uid = any(
        isinstance(node.get(k), str) and looks_like_id(node[k])
        for k in ID_KEYS
    )

    c = 0
    for k, v in node.items():
        c += 1
        if c > 60:
            break
        if k in SUB_COLLECTION_KEYS:
            # 子集合（楼中楼等）不并入当前条目的判定：
            # 否则父评论会因为"子评论的作者被屏蔽"而整条被误删。
            # 子项会在它自己那一层被独立判定，效果不变。
            continue
        if isinstance(v, str):
            if k in ID_KEYS and looks_like_id(v):
                out["ids"].add(v)
            elif k in NAME_KEYS and 0 < len(v) < 40 and has_uid:
                out["names"].add(v)
            elif k in SAFE_NAME_KEYS and 0 < len(v) < 40:
                # userName / nickname 这类明确指向用户的字段，无需 has_uid 也采信
                out["names"].add(v)
        elif isinstance(v, (dict, list)):
            collect(v, out, depth + 1)


def apply_block(data):
    items = load_block()
    ids = {str(x.get("userId")) for x in items if x.get("userId")}
    names = {x.get("name") for x in items if x.get("name")}
    if not ids and not names:
        return 0
    return scrub(data, ids, names)


# ══════════════════════════════════════════
#  HTTP 服务
# ══════════════════════════════════════════
MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass  # 安静一点，避免刷屏

    # ---- 工具 ----
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        b = body.encode("utf-8") if isinstance(body, str) else body
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            # 浏览器刷新/关页面/取消请求时会提前断开，属正常现象，静默忽略
            self._broken = True
        except OSError:
            self._broken = True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # ---- 路由 ----
    def _guard(self, fn):
        """包一层：任何异常都不让服务器进程崩掉，断连则静默。"""
        try:
            fn()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            self._broken = True
        except OSError:
            self._broken = True
        except Exception as e:
            if DEBUG_NET:
                import traceback
                traceback.print_exc()
            try:
                self._send(500, {"ok": False, "msg": "服务端异常：%s" % e})
            except Exception:
                pass

    def do_GET(self):
        self._guard(self._do_GET)

    def do_POST(self):
        self._guard(self._do_POST)

    def _do_GET(self):
        p = urlparse(self.path).path
        if p == "/api/status":
            return self._send(200, {
                "logged": bool(CRED.access),
                "expireIn": int(max(0, CRED.expire_at - time.time())),
                "hasRefresh": bool(CRED.refresh),
            })
        if p == "/api/block":
            return self._send(200, {"items": load_block()})
        # 静态文件
        rel = "index.html" if p in ("/", "") else p.lstrip("/")
        rel = rel.replace("..", "")  # 防目录穿越
        fp = os.path.join(WEB_DIR, rel)
        if not os.path.isfile(fp):
            fp = os.path.join(WEB_DIR, "index.html")
        try:
            with open(fp, "rb") as f:
                data = f.read()
        except OSError:
            return self._send(404, "not found", "text/plain; charset=utf-8")
        ext = os.path.splitext(fp)[1].lower()
        return self._send(200, data, MIME.get(ext, "application/octet-stream"))

    def _do_POST(self):
        p = urlparse(self.path).path
        b = self._body()

        # 油猴脚本把凭证送过来
        if p == "/api/token":
            a = (b.get("accessToken") or "").strip()
            r = (b.get("refreshToken") or "").strip()
            if not a and not r:
                return self._send(400, {"ok": False, "msg": "空的凭证"})
            CRED.save(a or None, r or None)
            print("[凭证] 已收到并保存")
            return self._send(200, {
                "ok": True,
                "expireIn": int(max(0, CRED.expire_at - time.time())),
            })

        if p == "/api/logout":
            CRED.clear()
            return self._send(200, {"ok": True})

        # 发图：GeneratePresignedURL → PUT → CreateFile
        if p == "/api/upload":
            import base64
            b64 = b.get("data") or ""
            if not b64:
                return self._send(400, {"ok": False, "msg": "没有图片数据"})
            # 前端传的是 dataURL（data:image/png;base64,xxx），也可能直接是 base64
            if "," in b64 and b64.strip().startswith("data:"):
                head, b64 = b64.split(",", 1)
                mime = head.split(";")[0].replace("data:", "") or "image/png"
            else:
                mime = b.get("mime") or "image/png"
            try:
                raw = base64.b64decode(b64)
            except Exception:
                return self._send(400, {"ok": False, "msg": "图片解码失败"})
            # 单张上限 10MB，避免把内存打满
            if len(raw) > 10 * 1024 * 1024:
                return self._send(400, {"ok": False, "msg": "单张图片不能超过 10MB"})
            try:
                r = upload_image(b.get("name") or "image", raw, mime,
                                 b.get("width"), b.get("height"))
                return self._send(200, {"ok": True, **r})
            except Exception as e:
                return self._send(200, {"ok": False, "msg": str(e)})

        # 屏蔽名单
        if p == "/api/block/add":
            items = load_block()
            uid = str(b.get("userId") or "")
            nm = (b.get("name") or "").strip()
            key = uid or "name:" + nm
            if not any((str(x.get("userId") or "") or "name:" + (x.get("name") or "")) == key
                       for x in items):
                items.insert(0, {"userId": uid, "name": nm, "time": int(time.time())})
                save_block(items)
            return self._send(200, {"ok": True, "items": items})

        if p == "/api/block/del":
            key = str(b.get("key") or "")
            items = [x for x in load_block()
                     if (str(x.get("userId") or "") or "name:" + (x.get("name") or "")) != key]
            save_block(items)
            return self._send(200, {"ok": True, "items": items})

        # 通用 RPC 代理
        if p == "/api/rpc":
            method = (b.get("method") or "").strip()
            if not method:
                return self._send(400, {"ok": False, "msg": "缺 method"})
            if not re.match(r"^[A-Za-z0-9_.]+/[A-Za-z0-9_]+$", method):
                return self._send(400, {"ok": False, "msg": "method 格式不对"})
            # 服务白名单：只放行社区相关的域，避免被拿去打账号/支付等敏感接口
            if method.split("/")[0] not in ALLOW_SERVICES:
                return self._send(400, {"ok": False, "msg": "不允许的服务"})
            # 高危方法拒绝：改绑手机/注销账号/删设备/删会话等不可逆操作
            if method in DENY_METHODS:
                return self._send(403, {"ok": False, "msg": "该操作已被本地服务禁止"})
            try:
                data = api_call(method, b.get("body") or {})
            except Exception as e:
                return self._send(200, {"ok": False, "msg": str(e)})
            removed = 0
            # 写操作一律不改写响应（避免把服务端返回的状态改坏）
            if b.get("filter", True) and method not in WRITE_METHODS:
                try:
                    removed = apply_block(data)
                except Exception:
                    removed = 0
            return self._send(200, {"ok": True, "data": data, "removed": removed})

        return self._send(404, {"ok": False, "msg": "unknown"})


class QuietServer(ThreadingHTTPServer):
    """关掉 socketserver 默认的异常堆栈刷屏。

    浏览器刷新/关闭标签页时连接会被提前断开，socketserver 默认会把
    ConnectionAbortedError / ConnectionResetError 打成长 traceback，
    看起来像崩了，其实完全正常。这里只在调试开关打开时才输出。
    """
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        if not DEBUG_NET:
            return
        import traceback
        print("[网络异常] %s" % (client_address,))
        traceback.print_exc()


def main():
    if not os.path.isdir(WEB_DIR):
        print("缺少 web/ 目录")
        sys.exit(1)
    port = PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    srv = QuietServer(("127.0.0.1", port), Handler)
    print("=" * 52)
    print("  Kimi 发现页（本地自建）")
    print("=" * 52)
    print("  打开：http://127.0.0.1:%d" % port)
    print("  凭证：%s" % ("已登录" if CRED.access else "未登录，需先去官网取"))
    print("  停止：Ctrl+C")
    print("  只监听本机，外网访问不到")
    print("=" * 52)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
