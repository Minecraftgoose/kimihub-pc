#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kimi 社区 CLI —— 给 AI / 终端用
================================

不启动 HTTP 服务，直接复用 server.py 的凭证与转发。
浏览器那份 web 页面不用开，token.json 存在就行。

常用：
    python3 cli.py status                    # 看登录状态
    python3 cli.py feed                      # 推荐流
    python3 cli.py feed --json --limit 10    # 结构化输出，给 AI 解析
    python3 cli.py moment <id>               # 动态详情 + 评论
    python3 cli.py comment <id> "写点什么"    # 发评论
    python3 cli.py post -t 标题 -f -         # 从 stdin 读正文发文
    python3 cli.py search moment 关键词       # 搜动态
    python3 cli.py user <userId>             # 用户主页
    python3 cli.py notify                    # 通知
    python3 cli.py blocklist                 # 本地屏蔽名单

所有子命令通用参数：
    -j / --json      输出 JSON（AI 最稳）
    --no-filter      关闭本地屏蔽过滤（看原始数据时用）
"""

import argparse
import json
import mimetypes
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 复用 server.py 的一切（不会启动 HTTP 服务，main() 只在 __main__ 里跑）
from server import (                                    # noqa: E402
    api_call, upload_image, apply_block, load_block, save_block,
    ALLOW_SERVICES, DENY_METHODS, WRITE_METHODS, CRED,
)

# ══════════════════════════════════════════════════════════
#  官方枚举（跟 app.js 对齐）
# ══════════════════════════════════════════════════════════
E_FEED_RECOMMEND   = "FEED_CATEGORY_RECOMMEND"
E_FEED_FOLLOW      = "FEED_CATEGORY_FOLLOW"
E_FEED_HASHTAG     = "FEED_CATEGORY_HASHTAG"
E_FEED_USER_PUBLISH= "FEED_CATEGORY_USER_PUBLISH"
E_FEED_TYPE_MOMENT = "FEED_TYPE_MOMENT"

E_VOTE_LIKE        = "MOMENT_VOTE_ACTION_LIKE"
E_VOTE_CANCEL_LIKE = "MOMENT_VOTE_ACTION_CANCEL_LIKE"
E_CMT_LIKE         = "COMMENT_VOTE_ACTION_LIKE"
E_CMT_CANCEL_LIKE  = "COMMENT_VOTE_ACTION_CANCEL_LIKE"

E_FOLLOW           = "FOLLOW_ACTION_FOLLOW"
E_UNFOLLOW         = "FOLLOW_ACTION_UNFOLLOW"
E_BLOCK            = "BLOCK_ACTION_BLOCK"
E_UNBLOCK          = "BLOCK_ACTION_UNBLOCK"
E_BLOCKED          = "BLOCK_STATUS_BLOCKED"

E_FOLLOWINGS       = "FOLLOW_TYPE_FOLLOWINGS"
E_FOLLOWERS        = "FOLLOW_TYPE_FOLLOWERS"

E_MUTE_MOMENT      = "MUTE_OBJECT_TYPE_MOMENT"
E_COMPLAIN_MOMENT  = "COMPLAINT_OBJECT_TYPE_MOMENT"

E_VIEW_FULL        = "USER_PROFILE_VIEW_FULL"
E_VIS_PUBLIC       = "MOMENT_VISIBILITY_PUBLIC"
E_VIS_SELF         = "MOMENT_VISIBILITY_SELF"

LIST_KEYS = {
    "moment.v1.FeedService/ListFeeds": "feeds",
    "moment.v1.CommentService/ListComments": "comments",
    "moment.v1.CommentService/ListSubComments": "subComments",
    "moment.v1.MomentService/ListSimilarMoments": "items",
    "moment.v1.FollowService/ListFollows": "userInfos",
    "moment.v1.SearchService/SearchMoments": "moments",
    "moment.v1.SearchService/SearchUsers": "users",
    "moment.v1.SearchService/SearchHashtags": "hashtags",
    "moment.v1.SearchService/SuggestSearchQuery": "suggestedQueries",
    "moment.v1.SearchService/ListHotHashtagsInSearch": "hashtags",
    "moment.v1.HashtagService/ListHashtags": "allHashtags",
    "moment.v1.NotificationService/ListNotification": "notifications",
}

# 全局开关
JSON_OUT  = False
NO_FILTER = False


# ══════════════════════════════════════════════════════════
#  基础工具
# ══════════════════════════════════════════════════════════
def die(msg, code=1):
    if JSON_OUT:
        print(json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False))
    else:
        sys.stderr.write("[错误] %s\n" % msg)
    sys.exit(code)


def require_login():
    if not CRED.access and not CRED.refresh:
        die("还没登录：先在浏览器用油猴脚本把凭证送到 server.py "
            "(或先跑一次 server.py + web 页面登录)")


def _api(method, body=None, filter=True):
    svc = method.split("/")[0]
    if svc not in ALLOW_SERVICES:
        die("服务不在白名单: %s" % svc)
    if method in DENY_METHODS:
        die("高危方法已禁用: %s" % method)
    try:
        data = api_call(method, body or {})
    except Exception as e:
        die("接口失败 %s: %s" % (method, e))
    # 写方法不过滤（避免污染响应）
    if filter and not NO_FILTER and method not in WRITE_METHODS:
        try:
            apply_block(data)
        except Exception:
            pass
    return data


def read(m, b=None):
    return _api(m, b, filter=True)


def write(m, b=None):
    return _api(m, b, filter=False)


def pick_list(d, method):
    key = LIST_KEYS.get(method)
    if key and isinstance(d.get(key), list):
        return d[key]
    for k in ("items", "list", "data", "results"):
        if isinstance(d.get(k), list):
            return d[k]
    return []


def unwrap(x):
    if not isinstance(x, dict):
        return x
    return x.get("moment") or x.get("userInfo") or x.get("hashtag") or x


def fmt_time(v):
    ms = to_ms(v)
    if not ms:
        return ""
    d = time.time() - ms / 1000
    if d < 60:      return "刚刚"
    if d < 3600:    return "%d 分钟前" % int(d / 60)
    if d < 86400:   return "%d 小时前" % int(d / 3600)
    if d < 2592000: return "%d 天前" % int(d / 86400)
    return time.strftime("%Y-%m-%d", time.localtime(ms / 1000))


def to_ms(v):
    if v is None:
        return 0
    if isinstance(v, dict):
        return int((v.get("seconds") or 0) * 1000)
    if isinstance(v, (int, float)):
        n = float(v)
        return int(n * 1000) if n < 1e12 else int(n)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return 0
        if s.isdigit():
            n = int(s)
            return n if n > 1e12 else n * 1000
        try:
            import datetime as _dt
            iso = s.replace("Z", "+00:00")
            dt = _dt.datetime.fromisoformat(iso)
            return int(dt.timestamp() * 1000)
        except Exception:
            pass
        for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ",
                    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                return int(time.mktime(time.strptime(s, fmt))) * 1000
            except ValueError:
                continue
        return 0
    return 0


def image_size(raw):
    """从裸字节读宽高。拿不到返回 (0,0)。"""
    try:
        if raw[:8] == b"\x89PNG\r\n\x1a\n":
            w, h = struct.unpack(">II", raw[16:24]); return int(w), int(h)
        if raw[:6] in (b"GIF87a", b"GIF89a"):
            w, h = struct.unpack("<HH", raw[6:10]); return int(w), int(h)
        if raw[:2] == b"\xff\xd8":
            i, n = 2, len(raw)
            while i < n - 9:
                if raw[i] != 0xFF:
                    i += 1; continue
                mk = raw[i + 1]
                if mk in (0xC0, 0xC1, 0xC2, 0xC3):
                    h, w = struct.unpack(">HH", raw[i + 5:i + 9]); return int(w), int(h)
                seg = struct.unpack(">H", raw[i + 2:i + 4])[0]
                i += 2 + seg
            return 0, 0
        if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            kind = raw[12:16]
            if kind == b"VP8 ":
                w, h = struct.unpack("<HH", raw[26:30])
                return int(w & 0x3FFF), int(h & 0x3FFF)
            if kind == b"VP8X":
                w = int.from_bytes(raw[24:27], "little") + 1
                h = int.from_bytes(raw[27:30], "little") + 1
                return w, h
    except Exception:
        pass
    return 0, 0


# ══════════════════════════════════════════════════════════
#  解析器（从 app.js 移植）
# ══════════════════════════════════════════════════════════
def parse_moment(raw):
    if not isinstance(raw, dict):
        return None
    m = raw.get("moment") if "moment" in raw else raw
    if not isinstance(m, dict):
        return None
    content = m.get("content") or {}
    stat    = m.get("stat") or {}
    author  = m.get("author") or {}
    base    = author.get("userBase") or author
    chat    = content.get("chatInfo") or {}
    card    = m.get("chatShareCard") or {}
    html_f  = card.get("htmlFile") or {}
    media   = content.get("media") or {}
    inter   = m.get("interactionStatus") or {}

    imgs = []
    for im in (media.get("images") or []):
        if not isinstance(im, dict):
            continue
        ex = im.get("extra") or {}
        imgs.append({
            "fileId": im.get("fileId") or "",
            "thumb":  im.get("thumbnailUrl") or im.get("originUrl") or "",
            "full":   im.get("originUrl") or im.get("thumbnailUrl") or "",
            "w": ex.get("width") or 0,
            "h": ex.get("height") or 0,
        })

    av = base.get("avatarImage") or {}
    return {
        "id":         m.get("id") or "",
        "title":      content.get("title") or "",
        "excerpt":    content.get("excerpt") or "",
        "text":       content.get("text") or "",
        "type":       content.get("type") or "",
        "segments":   [{"role": s.get("role", ""), "text": s.get("text", "")}
                       for s in (chat.get("segments") or []) if isinstance(s, dict)],
        "authorId":   base.get("userId") or "",
        "authorName": base.get("name") or "",
        "authorBio":  base.get("bio") or "",
        "avatar":     av.get("url") or av.get("thumbnailUrl") or "",
        "images":     imgs,
        "hashtags":   [{"id": h.get("id", ""), "name": h.get("name", "")}
                       for h in (m.get("hashtags") or []) if isinstance(h, dict)],
        "like":       stat.get("likeNum") or stat.get("likeCount") or 0,
        "comment":    stat.get("commentNum") or stat.get("commentCount") or 0,
        "collect":    stat.get("collectNum") or stat.get("collectCount") or 0,
        "time":       m.get("publishTime") or m.get("createTime") or "",
        "htmlUrl":    html_f.get("cdnUrl") or "",
        "notice":     card.get("notice") or "",
        "liked":      bool(inter.get("isLiked")),
        "collected":  bool(inter.get("isCollected")),
        "commentPresets": m.get("commentPresets") or [],
        "raw":        m,
    }


def parse_comment(raw, depth=0):
    if not isinstance(raw, dict):
        return None
    c = raw.get("comment") or raw.get("commentCard") or raw
    content = c.get("content") or {}
    stat    = c.get("stat") or {}
    inter   = c.get("interactionStatus") or {}
    author  = c.get("author") or {}
    base    = author.get("userBase") or author
    av = base.get("avatarImage") or {}
    sub_raw = c.get("subComments") or []
    subs = [x for x in (parse_comment(s, depth+1) for s in sub_raw) if x] if depth < 2 else []
    return {
        "id":         c.get("id") or c.get("commentId") or "",
        "momentId":   c.get("momentId") or "",
        "authorId":   base.get("userId") or "",
        "authorName": base.get("name") or "",
        "avatar":     av.get("url") or av.get("thumbnailUrl") or "",
        "text":       content.get("text") or "",
        "like":       stat.get("likeNum") or stat.get("likeCount") or 0,
        "subNum":     c.get("subCommentNum") or stat.get("replyNum") or 0,
        "time":       c.get("createTime") or "",
        "isBot":      c.get("type") == "COMMENT_TYPE_BOT",
        "ai":         bool(c.get("aiGenerated")),
        "liked":      bool(inter.get("isLiked")),
        "sub":        subs,
        "raw":        c,
    }


def parse_user(raw):
    if not isinstance(raw, dict):
        return None
    info = raw.get("userInfo") or raw.get("user") or raw
    base = (info.get("userBase") or info.get("base")
            or raw.get("userBase") or raw.get("base") or info)
    stat = (raw.get("userStat") or info.get("userStat")
            or raw.get("stat") or {})
    rel  = (raw.get("interactionStatus") or raw.get("relationStatus")
            or info.get("interactionStatus") or info.get("relationStatus") or {})
    av = base.get("avatarImage") or {}
    fs = rel.get("followStatus") or ""
    return {
        "id":          base.get("userId") or "",
        "name":        base.get("name") or "",
        "bio":         base.get("bio") or "",
        "avatar":      av.get("url") or av.get("thumbnailUrl") or "",
        "follower":    stat.get("followerNum") or stat.get("followerCount") or 0,
        "following":   stat.get("followingNum") or stat.get("followingCount") or 0,
        "momentCount": stat.get("momentNum") or stat.get("momentCount") or 0,
        "liked":       stat.get("momentLikesNum") or 0,
        "isFollowing":  fs in ("FOLLOW_STATUS_FOLLOWING", "FOLLOW_STATUS_MUTUAL_FOLLOWING")
                        or bool(rel.get("isFollowing")),
        "isFollowedBy": fs in ("FOLLOW_STATUS_FOLLOWED", "FOLLOW_STATUS_MUTUAL_FOLLOWING")
                        or bool(rel.get("isFollowedBy")),
        "isMutual":     fs == "FOLLOW_STATUS_MUTUAL_FOLLOWING" or bool(rel.get("isMutualFollowing")),
        "isBlocked":    rel.get("blockStatus") == E_BLOCKED or bool(rel.get("isBlocked")),
        "raw":          raw,
    }


def parse_hashtag(raw):
    h = (raw.get("hashtag") if isinstance(raw, dict) and "hashtag" in raw else raw) or {}
    if not isinstance(h, dict):
        return None
    icon = h.get("icon") or {}
    return {
        "id":    str(h.get("id") or ""),
        "name":  h.get("name") or "",
        "desc":  h.get("description") or h.get("desc") or "",
        "count": h.get("momentNum") or h.get("momentCount") or h.get("count") or 0,
        "icon":  icon.get("url") or "",
    }


NOTIF_ACTIONS = {
    "NOTIFICATION_TYPE_UP_MOMENT":     "赞了你的动态",
    "NOTIFICATION_TYPE_UP_COMMENT":    "赞了你的评论",
    "NOTIFICATION_TYPE_COMMENT_MOMENT":"评论了你的动态",
    "NOTIFICATION_TYPE_REPLY_COMMENT": "回复了你的评论",
    "NOTIFICATION_TYPE_FAVORITE":      "收藏了你的动态",
    "NOTIFICATION_TYPE_FOLLOW":        "关注了你",
    "NOTIFICATION_TYPE_MY_KIMI":       "提到了你",
}


def parse_notification(n, users, comments, moments):
    if not isinstance(n, dict):
        return None
    ids = []
    for x in (n.get("fromUsers") or []):
        if isinstance(x, str):
            ids.append(x)
        elif isinstance(x, dict):
            uid = x.get("userId") or (x.get("userBase") or {}).get("userId")
            if uid:
                ids.append(uid)
    first = ids[0] if ids else ""
    ub = users.get(first) or {}
    cid = n.get("commentId") or ""
    mid = n.get("momentId") or ""
    return {
        "id":         n.get("id") or "",
        "type":       n.get("notificationType") or n.get("type") or "",
        "action":     NOTIF_ACTIONS.get(n.get("notificationType") or n.get("type") or "", ""),
        "userIds":    ids,
        "userName":   ub.get("name") or "",
        "userCount":  len(ids),
        "momentId":   mid,
        "momentTitle":(moments.get(mid) or ""),
        "commentId":  cid,
        "commentText":(comments.get(cid) or ""),
        "time":       n.get("happenedTime") or "",
        "read":       bool(n.get("readTime")),
    }


# ══════════════════════════════════════════════════════════
#  文本输出
# ══════════════════════════════════════════════════════════
def body_of(p):
    if p["excerpt"]:
        return p["excerpt"]
    parts = []
    for s in p["segments"]:
        t = (s.get("text") or "").strip()
        if t:
            parts.append(t)
    return "\n\n".join(parts)


def out_moment(p):
    L = []
    L.append("[moment] id=%s" % p["id"])
    auth = p["authorName"] or "匿名"
    if p["authorId"]:
        auth += " (uid=%s)" % p["authorId"]
    L.append("作者: " + auth)
    L.append("时间: " + fmt_time(p["time"]))
    if p["title"]:
        L.append("标题: " + p["title"])
    b = body_of(p)
    if b:
        L.append("正文:")
        for ln in b.split("\n"):
            L.append("  " + ln)
    if p["hashtags"]:
        L.append("话题: " + " ".join("#" + h["name"] for h in p["hashtags"] if h.get("name")))
    if p["images"]:
        L.append("图片(%d):" % len(p["images"]))
        for im in p["images"]:
            u = im.get("full") or im.get("thumb")
            if u:
                L.append("  " + u)
    if p["htmlUrl"]:
        L.append("网页: " + p["htmlUrl"])
    L.append("互动: 赞 %s · 评论 %s · 收藏 %s%s" % (
        p["like"], p["comment"], p["collect"],
        " · 已赞" if p["liked"] else ""))
    return "\n".join(L)


def out_comment(c, depth=0):
    pad = "  " * depth
    marks = []
    if c.get("isBot"): marks.append("BOT")
    if c.get("ai"):    marks.append("AI")
    mark = (" [%s]" % ",".join(marks)) if marks else ""
    L = ["%s[comment] id=%s 作者=%s%s 时间=%s 赞=%s" % (
        pad, c["id"], c["authorName"] or "匿名", mark,
        fmt_time(c["time"]), c["like"])]
    for ln in (c["text"] or "").split("\n"):
        L.append("%s  %s" % (pad, ln))
    for s in c.get("sub", []):
        L.append(out_comment(s, depth + 1))
    return "\n".join(L)


def out_user(u):
    L = ["[user] id=%s" % u["id"], "昵称: " + (u["name"] or "(空)")]
    if u["bio"]:
        L.append("简介: " + u["bio"])
    rel = []
    if u["isFollowing"]:  rel.append("你已关注")
    if u["isFollowedBy"]: rel.append("关注了你")
    if u["isMutual"]:     rel.append("互关")
    if u["isBlocked"]:    rel.append("已拉黑")
    if rel:
        L.append("关系: " + " / ".join(rel))
    L.append("粉丝 %s · 关注 %s · 动态 %s · 获赞 %s" % (
        u["follower"], u["following"], u["momentCount"], u["liked"]))
    return "\n".join(L)


def out_hashtag(h):
    L = ["[hashtag] id=%s #%s" % (h["id"], h["name"])]
    if h["desc"]:
        L.append("简介: " + h["desc"])
    L.append("动态数: %s" % h["count"])
    return "\n".join(L)


def out_notification(n):
    who = n["userName"] or "用户"
    more = (" 等 %d 人" % n["userCount"]) if n["userCount"] > 1 else ""
    L = ["[notify] id=%s" % n["id"],
         "%s%s %s" % (who, more, n["action"] or n["type"])]
    if n["momentTitle"]:
        L.append("  我的动态: " + n["momentTitle"])
    if n["commentText"]:
        L.append("  评论: " + n["commentText"])
    L.append("  时间: " + fmt_time(n["time"]) + (" · 未读" if not n["read"] else ""))
    return "\n".join(L)


def emit_list(items, out_fn, next_token, label=None):
    if JSON_OUT:
        print(json.dumps({
            "ok": True, "items": items, "nextPageToken": next_token or "",
        }, ensure_ascii=False, default=str))
        return
    if not items:
        print("(空%s)" % (label or ""))
        return
    for i, x in enumerate(items):
        if i: print()
        print(out_fn(x))
    if next_token:
        print()
        print("next=%s" % next_token)


def emit_obj(data, out_fn=None):
    if JSON_OUT:
        print(json.dumps(data, ensure_ascii=False, default=str))
    elif out_fn:
        print(out_fn(data))
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2, default=str))


# ══════════════════════════════════════════════════════════
#  子命令实现
# ══════════════════════════════════════════════════════════
def cmd_status(args):
    st = {
        "logged": bool(CRED.access),
        "hasRefresh": bool(CRED.refresh),
        "expireIn": max(0, int(CRED.expire_at - time.time())),
    }
    if JSON_OUT:
        print(json.dumps(st, ensure_ascii=False))
    else:
        print("已登录" if st["logged"] else "未登录")
        if st["logged"]:
            print("剩余 %d 分钟，refresh token: %s" % (
                st["expireIn"] // 60, "有" if st["hasRefresh"] else "无"))


def cmd_feed(args):
    require_login()
    body = {"pageSize": args.limit, "category": E_FEED_RECOMMEND}
    if args.token:
        body["pageToken"] = args.token
    d = read("moment.v1.FeedService/ListFeeds", body)
    raw = pick_list(d, "moment.v1.FeedService/ListFeeds")
    items = [parse_moment(unwrap(f)) for f in raw]
    items = [x for x in items if x and (x["id"] or x["title"] or x["excerpt"])]
    emit_list(items, out_moment, d.get("nextPageToken", ""), "动态")


def cmd_mine(args):
    require_login()
    me = read("moment.v1.UserService/GetMe", {"view": E_VIEW_FULL})
    uid = (parse_user(me) or {}).get("id") or ""
    body = {"pageSize": args.limit, "category": E_FEED_FOLLOW}
    if uid:
        body["userId"] = uid
    if args.token:
        body["pageToken"] = args.token
    d = read("moment.v1.FeedService/ListFeeds", body)
    raw = pick_list(d, "moment.v1.FeedService/ListFeeds")
    items = [parse_moment(unwrap(f)) for f in raw]
    items = [x for x in items if x and (x["id"] or x["title"] or x["excerpt"])]
    emit_list(items, out_moment, d.get("nextPageToken", ""), "关注流动态")


def cmd_moment(args):
    require_login()
    mid = args.id
    d = read("moment.v1.FeedService/GetFeed",
             {"feedType": E_FEED_TYPE_MOMENT, "feedId": mid})
    feed = d.get("feed") or {}
    m = feed.get("moment") or d.get("moment") or d
    p = parse_moment(m)
    if not p or not p["id"]:
        die("打不开这条动态（接口没返回内容）")
    comments = []
    nc_token = ""
    if not args.no_comments:
        cd = read("moment.v1.CommentService/ListComments",
                  {"momentId": mid, "pageSize": args.limit})
        comments = [x for x in (parse_comment(c) for c in
                    pick_list(cd, "moment.v1.CommentService/ListComments")) if x]
        nc_token = cd.get("nextPageToken", "")
    if JSON_OUT:
        print(json.dumps({
            "ok": True, "moment": p, "comments": comments,
            "nextCommentToken": nc_token,
        }, ensure_ascii=False, default=str))
        return
    print(out_moment(p))
    if comments:
        print()
        print("──── 评论 %d 条 ────" % len(comments))
        for c in comments:
            print()
            print(out_comment(c))
        if nc_token:
            print()
            print("nextComments=%s" % nc_token)


def cmd_comments(args):
    require_login()
    d = read("moment.v1.CommentService/ListComments",
             {"momentId": args.id, "pageSize": args.limit})
    items = [x for x in (parse_comment(c) for c in
             pick_list(d, "moment.v1.CommentService/ListComments")) if x]
    emit_list(items, out_comment, d.get("nextPageToken", ""), "评论")


def cmd_similar(args):
    require_login()
    d = read("moment.v1.MomentService/ListSimilarMoments",
             {"momentId": args.id, "pageSize": args.limit})
    items = [x for x in (parse_moment(x) for x in
             pick_list(d, "moment.v1.MomentService/ListSimilarMoments")) if x and x["id"]]
    emit_list(items, out_moment, d.get("nextPageToken", ""))


def cmd_search(args):
    require_login()
    body = {"query": args.query, "pageSize": args.limit}
    if args.token:
        body["pageToken"] = args.token
    kind = args.kind
    if kind == "user":
        m = "moment.v1.SearchService/SearchUsers"
        d = read(m, body)
        items = [x for x in (parse_user(unwrap(u)) for u in pick_list(d, m)) if x and x["id"]]
        emit_list(items, out_user, d.get("nextPageToken", ""), "用户")
    elif kind == "hashtag":
        m = "moment.v1.SearchService/SearchHashtags"
        d = read(m, body)
        items = [x for x in (parse_hashtag(unwrap(h)) for h in pick_list(d, m)) if x and x["name"]]
        emit_list(items, out_hashtag, d.get("nextPageToken", ""), "话题")
    else:
        m = "moment.v1.SearchService/SearchMoments"
        d = read(m, body)
        items = [x for x in (parse_moment(unwrap(x)) for x in pick_list(d, m)) if x and x["id"]]
        emit_list(items, out_moment, d.get("nextPageToken", ""), "动态")


def cmd_hot(args):
    require_login()
    d = read("moment.v1.SearchService/ListHotHashtagsInSearch", {})
    items = [x for x in (parse_hashtag(unwrap(h)) for h in
             pick_list(d, "moment.v1.SearchService/ListHotHashtagsInSearch")) if x and x["name"]]
    if JSON_OUT:
        print(json.dumps({"ok": True, "items": items}, ensure_ascii=False, default=str))
    else:
        for h in items:
            print("#" + h["name"] + ("  (%s 条)" % h["count"] if h["count"] else ""))


def cmd_user(args):
    require_login()
    d = read("moment.v1.UserService/GetUserProfile", {"userId": args.id})
    u = parse_user(d)
    if not u or not u["id"]:
        die("拿不到用户信息: %s" % args.id)
    moments = []
    next_token = ""
    if not args.no_moments:
        fd = read("moment.v1.FeedService/ListFeeds", {
            "pageSize": args.limit,
            "category": E_FEED_USER_PUBLISH,
            "userId": u["id"],
        })
        moments = [x for x in (parse_moment(unwrap(x)) for x in
                   pick_list(fd, "moment.v1.FeedService/ListFeeds")) if x and x["id"]]
        next_token = fd.get("nextPageToken", "")
    if JSON_OUT:
        print(json.dumps({
            "ok": True, "user": u, "moments": moments,
            "nextPageToken": next_token,
        }, ensure_ascii=False, default=str))
        return
    print(out_user(u))
    if moments:
        print()
        print("──── TA 的动态 %d 条 ────" % len(moments))
        for x in moments:
            print()
            print(out_moment(x))
        if next_token:
            print()
            print("next=%s" % next_token)


def cmd_me(args):
    require_login()
    d = read("moment.v1.UserService/GetMe", {"view": E_VIEW_FULL})
    u = parse_user(d)
    if not u:
        die("拿不到自己的资料")
    if JSON_OUT:
        print(json.dumps({"ok": True, "user": u}, ensure_ascii=False, default=str))
    else:
        print(out_user(u))


def cmd_follows(args):
    require_login()
    ft = E_FOLLOWERS if args.followers else E_FOLLOWINGS
    d = read("moment.v1.FollowService/ListFollows", {
        "userId": args.id, "followType": ft, "pageSize": args.limit,
    })
    items = [x for x in (parse_user(unwrap(u)) for u in
             pick_list(d, "moment.v1.FollowService/ListFollows")) if x and x["id"]]
    emit_list(items, out_user, d.get("nextPageToken", ""))


def cmd_hashtag(args):
    require_login()
    key = args.id_or_name
    body = {"id": key} if key.isdigit() or key.startswith("h") else {"name": key}
    # 优先 GetHashtag by id
    try:
        d = read("moment.v1.HashtagService/GetHashtag", body)
    except SystemExit:
        raise
    h = parse_hashtag(d)
    if not h or not h["name"]:
        die("话题不存在: %s" % key)
    if JSON_OUT:
        print(json.dumps({"ok": True, "hashtag": h}, ensure_ascii=False, default=str))
    else:
        print(out_hashtag(h))


def cmd_notify(args):
    require_login()
    body = {"limit": args.limit}
    if args.token:
        body["idLt"] = args.token
    d = read("moment.v1.NotificationService/ListNotification", body)
    users = {}
    for u in (d.get("users") or []):
        base = u.get("userBase") or u
        if base.get("userId"):
            users[base["userId"]] = base
    comments = {}
    for c in (d.get("comments") or []):
        cc = c.get("comment") or c
        if cc.get("id"):
            comments[cc["id"]] = (cc.get("content") or {}).get("text") or ""
    moments = {}
    for m in (d.get("moments") or []):
        mm = m.get("moment") or m
        if mm.get("id"):
            moments[mm["id"]] = (mm.get("content") or {}).get("title") or ""
    items = [x for x in (parse_notification(n, users, comments, moments)
             for n in (d.get("notifications") or [])) if x and x["id"]]
    last = items[-1]["id"] if items else ""
    npt = last if (len(items) >= args.limit and last) else ""
    if JSON_OUT:
        print(json.dumps({"ok": True, "items": items, "nextPageToken": npt},
                        ensure_ascii=False, default=str))
        return
    if not items:
        print("(没有通知)")
        return
    for i, n in enumerate(items):
        if i: print()
        print(out_notification(n))
    if npt:
        print()
        print("next=%s" % npt)


# ── 写操作 ──────────────────────────────────────────────
def _ok(msg, extra=None):
    if JSON_OUT:
        out = {"ok": True}
        if extra:
            out.update(extra)
        print(json.dumps(out, ensure_ascii=False, default=str))
    else:
        print(msg)


def cmd_like(args):
    require_login()
    write("moment.v1.MomentService/VoteMoment",
          {"momentId": args.id, "voteAction": E_VOTE_LIKE})
    _ok("已点赞 %s" % args.id)


def cmd_unlike(args):
    require_login()
    write("moment.v1.MomentService/VoteMoment",
          {"momentId": args.id, "voteAction": E_VOTE_CANCEL_LIKE})
    _ok("已取消点赞 %s" % args.id)


def cmd_fav(args):
    require_login()
    write("moment.v1.FavoriteService/CreateFavorite", {"momentId": args.id})
    _ok("已收藏 %s" % args.id)


def cmd_unfav(args):
    require_login()
    write("moment.v1.FavoriteService/DeleteFavorite", {"momentId": args.id})
    _ok("已取消收藏 %s" % args.id)


def cmd_comment(args):
    require_login()
    text = _read_text_arg(args.text)
    body = {"momentId": args.moment_id, "content": {"text": text}}
    if args.reply:
        body["targetCommentId"] = args.reply
    write("moment.v1.CommentService/CreateComment", body)
    _ok("评论已发送")


def cmd_follow(args):
    require_login()
    write("moment.v1.FollowService/ModifyFollow",
          {"userId": args.uid, "action": E_FOLLOW})
    _ok("已关注 %s" % args.uid)


def cmd_unfollow(args):
    require_login()
    write("moment.v1.FollowService/ModifyFollow",
          {"userId": args.uid, "action": E_UNFOLLOW})
    _ok("已取关 %s" % args.uid)


def cmd_block(args):
    require_login()
    try:
        write("moment.v1.FollowService/ModifyBlock",
              {"userId": args.uid, "action": E_BLOCK})
    except SystemExit:
        raise
    except Exception:
        pass
    items = load_block()
    if not any((x.get("userId") or "") == args.uid for x in items):
        items.insert(0, {"userId": args.uid, "name": args.name or "",
                         "time": int(time.time())})
        save_block(items)
    _ok("已拉黑 %s（服务端 + 本地）" % args.uid)


def cmd_unblock(args):
    require_login()
    try:
        write("moment.v1.FollowService/ModifyBlock",
              {"userId": args.uid, "action": E_UNBLOCK})
    except SystemExit:
        raise
    except Exception:
        pass
    items = [x for x in load_block() if (x.get("userId") or "") != args.uid]
    save_block(items)
    _ok("已解除拉黑 %s" % args.uid)


def cmd_blocklist(args):
    items = load_block()
    if JSON_OUT:
        print(json.dumps({"ok": True, "items": items}, ensure_ascii=False))
        return
    if not items:
        print("(空)")
        return
    for x in items:
        print("userId=%s  name=%s  time=%s" % (
            x.get("userId") or "-", x.get("name") or "-",
            fmt_time(x.get("time"))))


def cmd_delete_moment(args):
    require_login()
    write("moment.v1.MomentService/DeleteMoment", {"momentId": args.id})
    _ok("已删除动态 %s" % args.id)


def cmd_delete_comment(args):
    require_login()
    write("moment.v1.CommentService/DeleteComment", {"commentId": args.id})
    _ok("已删除评论 %s" % args.id)


def _read_text_arg(v):
    if v == "-" or v is None:
        return sys.stdin.read().strip()
    return v.strip()


def cmd_post(args):
    require_login()
    title = (args.title or "").strip()
    if args.file:
        if args.file == "-":
            text = sys.stdin.read()
        else:
            try:
                with open(args.file, "r", encoding="utf-8") as f:
                    text = f.read()
            except OSError as e:
                die("读文件失败: %s" % e)
    elif args.text:
        text = args.text
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        die("正文为空：用 -f 文件、-f - 从 stdin、或直接给位置参数")
    text = (text or "").strip()
    if not text:
        die("正文为空")

    images = []
    for path in (args.image or []):
        try:
            raw = open(path, "rb").read()
        except OSError as e:
            die("读图片失败 %s: %s" % (path, e))
        if len(raw) > 10 * 1024 * 1024:
            die("%s 超过 10MB" % path)
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        w, h = image_size(raw)
        try:
            up = upload_image(os.path.basename(path), raw, mime, w, h)
        except Exception as e:
            die("上传 %s 失败: %s" % (path, e))
        images.append({
            "fileId": up.get("fileId") or "",
            "extra":  {"width": w, "height": h},
        })

    body = {
        "title": title,
        "text": text,
        "visibility": E_VIS_SELF if args.private else E_VIS_PUBLIC,
    }
    if images:
        body["images"] = images
    d = write("moment.v1.MomentService/CreateMoment", body)
    m = d.get("moment") or d
    mid = m.get("id") if isinstance(m, dict) else ""
    _ok("已发布 momentId=%s" % (mid or "(接口未返回 id)"),
        {"momentId": mid})


# ══════════════════════════════════════════════════════════
#  命令行入口
# ══════════════════════════════════════════════════════════
def build_parser():
    ap = argparse.ArgumentParser(
        prog="cli.py",
        description="Kimi 社区 CLI（给 AI / 终端用）。所有子命令都支持 --json。",
    )
    sub = ap.add_subparsers(dest="cmd")

    def p(name, help_):
        sp = sub.add_parser(name, help=help_, description=help_)
        sp.add_argument("-j", "--json", action="store_true", help="JSON 输出")
        sp.add_argument("--no-filter", action="store_true", help="不做本地屏蔽过滤")
        return sp

    sp = p("status", "登录状态")
    sp.set_defaults(fn=cmd_status)

    sp = p("feed", "推荐流")
    sp.add_argument("--limit", type=int, default=20)
    sp.add_argument("--token", default="")
    sp.set_defaults(fn=cmd_feed)

    sp = p("mine", "关注流")
    sp.add_argument("--limit", type=int, default=20)
    sp.add_argument("--token", default="")
    sp.set_defaults(fn=cmd_mine)

    sp = p("moment", "动态详情 + 评论")
    sp.add_argument("id")
    sp.add_argument("--limit", type=int, default=50, help="评论条数")
    sp.add_argument("--no-comments", action="store_true")
    sp.set_defaults(fn=cmd_moment)

    sp = p("comments", "只列评论")
    sp.add_argument("id", help="momentId")
    sp.add_argument("--limit", type=int, default=50)
    sp.set_defaults(fn=cmd_comments)

    sp = p("similar", "相似动态")
    sp.add_argument("id")
    sp.add_argument("--limit", type=int, default=10)
    sp.set_defaults(fn=cmd_similar)

    sp = p("search", "搜索")
    sp.add_argument("kind", choices=["moment", "user", "hashtag"])
    sp.add_argument("query")
    sp.add_argument("--limit", type=int, default=20)
    sp.add_argument("--token", default="")
    sp.set_defaults(fn=cmd_search)

    sp = p("hot", "热搜话题")
    sp.set_defaults(fn=cmd_hot)

    sp = p("user", "用户主页")
    sp.add_argument("id", help="userId")
    sp.add_argument("--limit", type=int, default=20, help="动态条数")
    sp.add_argument("--no-moments", action="store_true")
    sp.set_defaults(fn=cmd_user)

    sp = p("me", "我的资料")
    sp.set_defaults(fn=cmd_me)

    sp = p("follows", "关注/粉丝列表")
    sp.add_argument("id", help="userId")
    sp.add_argument("--followers", action="store_true", help="拉粉丝（默认拉关注）")
    sp.add_argument("--limit", type=int, default=50)
    sp.set_defaults(fn=cmd_follows)

    sp = p("hashtag", "话题详情")
    sp.add_argument("id_or_name")
    sp.set_defaults(fn=cmd_hashtag)

    sp = p("notify", "通知")
    sp.add_argument("--limit", type=int, default=30)
    sp.add_argument("--token", default="")
    sp.set_defaults(fn=cmd_notify)

    # ── 写操作 ──
    sp = p("like", "点赞")
    sp.add_argument("id"); sp.set_defaults(fn=cmd_like)

    sp = p("unlike", "取消点赞")
    sp.add_argument("id"); sp.set_defaults(fn=cmd_unlike)

    sp = p("fav", "收藏")
    sp.add_argument("id"); sp.set_defaults(fn=cmd_fav)

    sp = p("unfav", "取消收藏")
    sp.add_argument("id"); sp.set_defaults(fn=cmd_unfav)

    sp = p("comment", "发评论（正文 - 表示从 stdin 读）")
    sp.add_argument("moment_id")
    sp.add_argument("text")
    sp.add_argument("--reply", default="", help="回复某条评论的 commentId")
    sp.set_defaults(fn=cmd_comment)

    sp = p("follow", "关注")
    sp.add_argument("uid"); sp.set_defaults(fn=cmd_follow)

    sp = p("unfollow", "取关")
    sp.add_argument("uid"); sp.set_defaults(fn=cmd_unfollow)

    sp = p("block", "拉黑（服务端 + 本地）")
    sp.add_argument("uid")
    sp.add_argument("--name", default="")
    sp.set_defaults(fn=cmd_block)

    sp = p("unblock", "解除拉黑")
    sp.add_argument("uid"); sp.set_defaults(fn=cmd_unblock)

    sp = p("blocklist", "本地屏蔽名单")
    sp.set_defaults(fn=cmd_blocklist)

    sp = p("delete-moment", "删除自己的动态")
    sp.add_argument("id"); sp.set_defaults(fn=cmd_delete_moment)

    sp = p("delete-comment", "删除自己的评论")
    sp.add_argument("id"); sp.set_defaults(fn=cmd_delete_comment)

    sp = p("post", "发动态（-f - 从 stdin 读正文）")
    sp.add_argument("text", nargs="?", default="", help="正文（短则直接给）")
    sp.add_argument("-t", "--title", default="")
    sp.add_argument("-f", "--file", default="", help="正文文件；- 表示 stdin")
    sp.add_argument("-i", "--image", action="append", default=[], help="图片路径，可多次")
    sp.add_argument("--private", action="store_true", help="仅自己可见")
    sp.set_defaults(fn=cmd_post)

    return ap


def main():
    global JSON_OUT, NO_FILTER
    ap = build_parser()
    args = ap.parse_args()
    if not args.cmd:
        ap.print_help()
        return
    JSON_OUT  = getattr(args, "json", False)
    NO_FILTER = getattr(args, "no_filter", False)
    try:
        args.fn(args)
    except SystemExit:
        raise
    except KeyboardInterrupt:
        die("已中断", 130)
    except Exception as e:
        die(e)


if __name__ == "__main__":
    main()