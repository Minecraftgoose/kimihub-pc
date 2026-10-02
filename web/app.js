/* Kimi 社区（本地净空版） — 完整功能 SPA
 *
 * 路由（hash）：
 *   #/feed              推荐信息流
 *   #/mine              关注流
 *   #/search            搜索（动态/用户/话题 + 热搜榜）
 *   #/notify            通知
 *   #/me                我的主页
 *   #/block             本地屏蔽名单
 *   #/moment/:id        动态详情（网页预览 + 评论 + 相似推荐）
 *   #/user/:id          他人主页（动态 + 关注/取关/拉黑）
 *   #/follows/:id       关注列表
 *   #/hashtag/:id       话题页
 *
 * 接口覆盖 moment.v1 全量：Feed / Moment / Comment / User / Search /
 *   Hashtag / Notification / Favorite / Follow / Mute / Complaint / Config
 *
 * 本次改动：
 *   · 全站 emoji 图标 → Font Awesome 6
 *   · 新增浅色 / 深色主题切换（localStorage + 跟随系统）
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ══════════════════════════════════════════
//  官方枚举常量
//  来源：Kimi Android 逆向文档 附录 B（158 enums）+ 各接口请求体定义
// ══════════════════════════════════════════
const E = {
  // FeedService/ListFeeds · category
  FEED_RECOMMEND: "FEED_CATEGORY_RECOMMEND",
  FEED_FOLLOW: "FEED_CATEGORY_FOLLOW",
  FEED_HASHTAG: "FEED_CATEGORY_HASHTAG",
  FEED_USER_PUBLISH: "FEED_CATEGORY_USER_PUBLISH",
  FEED_USER_LIKES: "FEED_CATEGORY_USER_LIKES",
  FEED_USER_FAVORITE: "FEED_CATEGORY_USER_FAVORITE",

  // FeedService/GetFeed · feedType
  FEED_TYPE_MOMENT: "FEED_TYPE_MOMENT",

  // MomentService/VoteMoment · voteAction
  VOTE_LIKE: "MOMENT_VOTE_ACTION_LIKE",
  VOTE_CANCEL_LIKE: "MOMENT_VOTE_ACTION_CANCEL_LIKE",
  VOTE_DISLIKE: "MOMENT_VOTE_ACTION_DISLIKE",
  VOTE_CANCEL_DISLIKE: "MOMENT_VOTE_ACTION_CANCEL_DISLIKE",

  // CommentService/VoteComment · voteAction
  CMT_LIKE: "COMMENT_VOTE_ACTION_LIKE",
  CMT_CANCEL_LIKE: "COMMENT_VOTE_ACTION_CANCEL_LIKE",
  CMT_DISLIKE: "COMMENT_VOTE_ACTION_DISLIKE",
  CMT_CANCEL_DISLIKE: "COMMENT_VOTE_ACTION_CANCEL_DISLIKE",

  // MuteService · objectType
  MUTE_MOMENT: "MUTE_OBJECT_TYPE_MOMENT",
  MUTE_BOT_COMMENT: "MUTE_OBJECT_TYPE_BOT_COMMENT",
  MUTE_AIGC: "MUTE_OBJECT_TYPE_AIGC_MOMENT_CONTENT",

  // FollowService/ModifyBlock · action
  BLOCK: "BLOCK_ACTION_BLOCK",
  UNBLOCK: "BLOCK_ACTION_UNBLOCK",
  // ModifyBlockResponse · blockStatus
  BLOCKED: "BLOCK_STATUS_BLOCKED",
  NOT_BLOCKED: "BLOCK_STATUS_NOT_BLOCKED",

  // FollowService/ModifyFollow · action
  FOLLOW: "FOLLOW_ACTION_FOLLOW",
  UNFOLLOW: "FOLLOW_ACTION_UNFOLLOW",
  // UserRelationStatus · followStatus
  FS_MUTUAL: "FOLLOW_STATUS_MUTUAL_FOLLOWING",
  FS_FOLLOWING: "FOLLOW_STATUS_FOLLOWING",
  FS_FOLLOWED: "FOLLOW_STATUS_FOLLOWED",
  FS_NONE: "FOLLOW_STATUS_NOT_FOLLOWING",

  // FollowService/ListFollows · followType
  FOLLOWINGS: "FOLLOW_TYPE_FOLLOWINGS",
  FOLLOWERS: "FOLLOW_TYPE_FOLLOWERS",

  // ComplaintService · objectType
  COMPLAIN_MOMENT: "COMPLAINT_OBJECT_TYPE_MOMENT",
  COMPLAIN_COMMENT: "COMPLAINT_OBJECT_TYPE_COMMENT",
  COMPLAIN_USER: "COMPLAINT_OBJECT_TYPE_USER",

  // UserService/GetMe · view
  VIEW_FULL: "USER_PROFILE_VIEW_FULL",

  // MomentService/CreateMoment · visibility
  VIS_PUBLIC: "MOMENT_VISIBILITY_PUBLIC",
  VIS_SELF: "MOMENT_VISIBILITY_SELF",
};

// ══════════════════════════════════════════
//  实测确认：各接口返回数组字段名
// ══════════════════════════════════════════
const LIST_KEYS = {
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
  "kimi.gateway.device.v1.DeviceService/ListDevices": "devices",
  "kimi.gateway.membership.v2.MembershipService/GetSubscription": "balances",
};

// 取数组：按实测字段名，同时保留若干历史别名兜底
function pickList(d, method) {
  if (!d || typeof d !== "object") return [];
  const key = LIST_KEYS[method];
  if (key && Array.isArray(d[key])) return d[key];
  for (const k of ["items", "list", "data", "results"]) {
    if (Array.isArray(d[k])) return d[k];
  }
  return [];
}

// 剥掉搜索结果的外包层：item.moment / item.userInfo / item.hashtag
function unwrap(item) {
  if (!item || typeof item !== "object") return item;
  return item.moment || item.userInfo || item.hashtag || item;
}

// 分页游标：官方字段是 pageToken / nextPageToken
const PT = "pageToken";
const NPT = "nextPageToken";

// ══════════════════════════════════════════
//  全局状态
// ══════════════════════════════════════════
const S = {
  me: null,
  cache: {},        // momentId -> 动态对象
  userCache: {},    // userId -> 用户资料
  block: [],        // 本地屏蔽名单
  route: null,
  lists: {},
  userPage: null,   // 个人主页 DOM 缓存 {id, html}，返回时直接还原
};

function listState(key) {
  if (!S.lists[key]) {
    S.lists[key] = { items: [], token: "", loaded: false, scroll: 0, loading: false, extra: null };
  }
  return S.lists[key];
}

// 从任意形态的用户对象里挖 userId
function myIdFrom(me) {
  if (!me || typeof me !== "object") return "";
  const cands = [
    me.userId,
    me.userBase && me.userBase.userId,
    me.id,
    me.globalId,
    me.userInfo && me.userInfo.userId,
    me.userInfo && me.userInfo.userBase && me.userInfo.userBase.userId,
    me.userInfo && me.userInfo.id,
    me.user && (me.user.id || me.user.userId || me.user.globalId),
  ];
  for (const v of cands) {
    if (typeof v === "string" && v) return v;
    if (typeof v === "number" && v) return String(v);
  }
  return "";
}

function myId() {
  return myIdFrom(S.me);
}

// ══════════════════════════════════════════
//  主题：浅色 / 深色
// ══════════════════════════════════════════
const THEME_KEY = "theme";

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** 应用主题：写 data-theme + localStorage + 按钮图标 */
function applyTheme(t) {
  const dark = t === "dark";
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch (e) { /* 隐私模式 */ }

  const b = document.getElementById("btnTheme");
  if (b) {
    b.innerHTML = dark
      ? '<i class="fa-solid fa-sun"></i>'
      : '<i class="fa-solid fa-moon"></i>';
    b.title = dark ? "切换到浅色" : "切换到深色";
    b.setAttribute("aria-label", b.title);
  }
  // 同步移动端浏览器地址栏颜色（没有该 meta 就跳过）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0f1115" : "#ffffff");
}

/** 初始化主题：本地存储 > 系统偏好；未手动选过时跟随系统变化 */
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* 忽略 */ }

  let t = saved;
  if (t !== "light" && t !== "dark") {
    t = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark" : "light";
  }
  applyTheme(t);

  const b = document.getElementById("btnTheme");
  if (b) b.onclick = () => applyTheme(currentTheme() === "dark" ? "light" : "dark");

  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      let cur = null;
      try { cur = localStorage.getItem(THEME_KEY); } catch (e) { /* 忽略 */ }
      // 用户手动选过就不跟随系统
      if (cur !== "light" && cur !== "dark") applyTheme(mq.matches ? "dark" : "light");
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
}

// ══════════════════════════════════════════
//  网络
// ══════════════════════════════════════════
async function rpc(method, body = {}, filter = true) {
  const r = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, body, filter }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.msg || "请求失败");
  return j.data;
}

/** 读接口：默认过滤（把被屏蔽的人删掉） */
const read = (m, b) => rpc(m, b, true);
/** 写接口：不过滤响应 */
const write = (m, b) => rpc(m, b, false);

async function api(path, body) {
  const r = await fetch(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

// ══════════════════════════════════════════
//  工具
// ══════════════════════════════════════════
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("on"), 2200);
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s == null ? "" : s);
  return d.innerHTML;
}

function toMs(v) {
  if (!v && v !== 0) return 0;
  if (typeof v === "object") {
    if (typeof v.seconds === "number") v = v.seconds;
    else if (typeof v.nanos === "number") v = v.nanos / 1e6;
    else return 0;
  }
  if (typeof v === "boolean") return 0;
  if (typeof v === "number") return isFinite(v) ? (v > 1e12 ? v : v * 1000) : 0;
  if (typeof v !== "string") return 0;
  const s = v.trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 1e12 ? n : n * 1000; }
  let d = Date.parse(s);
  if (isNaN(d)) d = Date.parse(s.replace(/\.(\d{3})\d+/, ".$1"));
  if (isNaN(d)) d = Date.parse(s.replace(" ", "T"));
  return isNaN(d) ? 0 : d;
}

function fmtTime(v) {
  const ms = toMs(v);
  if (!ms) return "";
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return Math.floor(d / 60) + " 分钟前";
  if (d < 86400) return Math.floor(d / 3600) + " 小时前";
  if (d < 2592000) return Math.floor(d / 86400) + " 天前";
  const t = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function num(n) {
  n = Number(n) || 0;
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "万";
  return String(n);
}

// ── 图标小工具（Font Awesome） ──
const ICON = {
  like:  '<i class="fa-solid fa-thumbs-up"></i>',
  cmt:   '<i class="fa-regular fa-comment"></i>',
  star:  '<i class="fa-solid fa-star"></i>',
  more:  '<i class="fa-solid fa-ellipsis"></i>',
  trash: '<i class="fa-solid fa-trash-can"></i>',
  close: '<i class="fa-solid fa-xmark"></i>',
  plus:  '<i class="fa-solid fa-plus"></i>',
  caretR:'<i class="fa-solid fa-caret-right"></i>',
  caretD:'<i class="fa-solid fa-caret-down"></i>',
  prev:  '<i class="fa-solid fa-chevron-left"></i>',
  next:  '<i class="fa-solid fa-chevron-right"></i>',
  reload:'<i class="fa-solid fa-rotate-right"></i>',
  up:    '<i class="fa-solid fa-chevron-up"></i>',
  down:  '<i class="fa-solid fa-chevron-down"></i>',
  fire:  '<i class="fa-solid fa-fire"></i>',
  spark: '<i class="fa-solid fa-wand-magic-sparkles"></i>',
  ext:   '<i class="fa-solid fa-arrow-up-right-from-square"></i>',
};

// ══════════════════════════════════════════
//  原始 JSON 折叠块（懒加载）
// ══════════════════════════════════════════
const RAW_STORE = Object.create(null);
let rawSeq = 0;

function rawBlock(obj, label) {
  if (obj === undefined || obj === null) return "";
  const id = "rw" + (++rawSeq);
  RAW_STORE[id] = obj;
  return `<span class="raw-toggle" data-raw="${id}">${ICON.caretR} ${esc(label || "原始 JSON")}</span>` +
         `<pre class="raw" data-raw-pre="${id}" style="display:none"></pre>`;
}

/** 抠出 markdown 里的 ```html 代码块 */
function splitMarkdownHtml(md) {
  if (!md || typeof md !== "string") return { plain: "", htmlBlocks: [] };
  const blocks = [];
  const re = /```(?:html|HTML)?\s*([\s\S]*?)```/g;
  let plain = md.replace(re, (w, code) => {
    const t = String(code || "").trim();
    if (/^\s*<!DOCTYPE|<html[\s>]|<body[\s>]|<div[\s>]|<canvas[\s>]|<script[\s>]/i.test(t)) {
      blocks.push(t); return "\n[网页预览见下方]\n";
    }
    return "\n```\n" + t + "\n```\n";
  });
  plain = plain.replace(/\n{3,}/g, "\n\n");
  return { plain, htmlBlocks: blocks };
}

function highlightMentions(text, mentions) {
  if (!text) return "";
  let t = esc(text);
  if (Array.isArray(mentions)) {
    for (const m of mentions) {
      const n = m && m.name;
      if (!n) continue;
      const en = esc(n);
      t = t.split("@" + en).join('<span class="mention">@' + en + "</span>");
    }
  }
  return t;
}

function avatarHtml(name, url, cls) {
  const ch = esc((name || "匿").charAt(0));
  if (!url) return `<div class="avatar ${cls || ""}">${ch}</div>`;
  return `<div class="avatar ${cls || ""}" data-fallback="${ch}">
    <img src="${esc(url)}" loading="lazy" referrerpolicy="no-referrer"
         onerror="this.parentNode.textContent=this.parentNode.dataset.fallback;
                  this.parentNode.classList.add('noimg')"></div>`;
}

function skel(n = 4) {
  let h = "";
  for (let i = 0; i < n; i++) {
    h += `<div class="sk"><i style="width:30%"></i><i style="width:100%"></i>
          <i style="width:80%"></i><i style="width:45%"></i></div>`;
  }
  return h;
}

// ══════════════════════════════════════════
//  动态结构归一化
//   ① 标准 Moment  { content:{...}, author:{userBase}, ... }
//   ② 扁平形态     { title, excerpt, author:{userId,...}, images:[...] }
// ══════════════════════════════════════════
function normalizeMoment(m) {
  if (!m || typeof m !== "object") return m;
  if (m.content) return m;   // 已经是标准形态

  const flat = m;
  let imgs = Array.isArray(flat.images) ? flat.images.slice() : [];
  if (flat.image && !imgs.some(x => x && x.fileId === flat.image.fileId)) {
    imgs.unshift(flat.image);
  }
  imgs = imgs.filter(x => x && typeof x === "object").map(im => ({
    fileId: im.fileId || "",
    originUrl: im.url || im.originUrl || "",
    thumbnailUrl: im.thumbnailUrl || im.url || "",
    extra: {
      width: Number(im.width || (im.extra && im.extra.width) || 0) || 0,
      height: Number(im.height || (im.extra && im.extra.height) || 0) || 0,
    },
  }));

  const au = flat.author || {};
  const base = au.userBase || au;

  return {
    id: flat.id || "",
    content: {
      title: flat.title || "",
      excerpt: flat.excerpt || "",
      text: flat.text || "",
      type: flat.type || (imgs.length ? "MOMENT_TYPE_IMAGE" : ""),
      media: { images: imgs },
      mentions: Array.isArray(flat.mentions) ? flat.mentions : [],
    },
    author: {
      userBase: {
        userId: base.userId || "",
        name: base.name || "",
        bio: base.bio || "",
        avatarImage: base.avatarImage || (base.avatarUrl ? { url: base.avatarUrl } : {}),
      },
    },
    stat: flat.stat || {},
    hashtags: Array.isArray(flat.hashtags) ? flat.hashtags : [],
    createTime: flat.createTime || "",
    publishTime: flat.publishTime || flat.createTime || "",
    interactionStatus: flat.interactionStatus || {},
    chatShareCard: flat.chatShareCard || {},
    commentPresets: flat.commentPresets || [],
    coverImage: flat.coverImage || "",
    via: flat.via || "",
    trackVia: flat.trackVia || "",
    __raw: flat,
  };
}

function parseMoment(raw) {
  const wrap = raw && typeof raw === "object" ? raw : {};
  const m = normalizeMoment(wrap.moment || wrap.momentCard || wrap);
  const content = m.content || {};
  const stat = m.stat || m.stats || {};
  const author = m.author || {};
  const base = author.userBase || author;
  const chatInfo = content.chatInfo || {};
  const card = m.chatShareCard || {};
  const htmlFile = card.htmlFile || {};
  const coverImg = m.coverImage || htmlFile.coverImage || {};

  const media = content.media || {};
  const images = (Array.isArray(media.images) ? media.images : [])
    .map(im => {
      if (!im || typeof im !== "object") return null;
      const ex = im.extra || {};
      return {
        fileId: im.fileId || "",
        thumb: im.thumbnailUrl || im.originUrl || im.downloadUrl || "",
        full: im.originUrl || im.thumbnailUrl || im.downloadUrl || "",
        w: ex.width || (im.thumbnailExtra && im.thumbnailExtra.width) || 0,
        h: ex.height || (im.thumbnailExtra && im.thumbnailExtra.height) || 0,
      };
    })
    .filter(x => x && (x.thumb || x.full));

  const mtype = content.type || "";
  const isChatPost = mtype === "MOMENT_TYPE_CHAT";
  const isImagePost = mtype === "MOMENT_TYPE_IMAGE" || (!mtype && images.length > 0);

  const htmlUrl = htmlFile.cdnUrl || "";
  let htmlCode = "";
  if (!htmlUrl && Array.isArray(chatInfo.segments)) {
    for (const s of chatInfo.segments) {
      const r = splitMarkdownHtml(s && s.text);
      if (r.htmlBlocks.length) { htmlCode = r.htmlBlocks[0]; break; }
    }
  }
  const inter = m.interactionStatus || {};
  return {
    id: m.id || wrap.feedId || "",
    title: content.title || "",
    excerpt: content.excerpt || "",
    segments: Array.isArray(chatInfo.segments) ? chatInfo.segments : [],
    authorId: base.userId || author.userId || "",
    authorName: base.name || author.name || "",
    authorBio: base.bio || "",
    avatar: (base.avatarImage && (base.avatarImage.url || base.avatarImage.thumbnailUrl)) || "",
    like: stat.likeNum ?? stat.likeCount ?? 0,
    comment: stat.commentNum ?? stat.commentCount ?? 0,
    collect: stat.collectNum ?? stat.collectCount ?? 0,
    time: m.publishTime || m.createTime || "",
    hashtags: Array.isArray(m.hashtags) ? m.hashtags : [],
    images,
    isImagePost,
    isChatPost,
    cover: isImagePost ? "" : (
      (images.length && (images[0].thumb || images[0].full)) ||
      (coverImg.thumbnailUrl || coverImg.url || "")),
    coverFull: isImagePost ? "" : (
      (images.length && (images[0].full || images[0].thumb)) ||
      (coverImg.originUrl || coverImg.url || "")),
    coverColor: htmlFile.coverImageDominantColor || "",
    htmlUrl, htmlCode,
    notice: card.notice || "",
    noticeIcon: card.noticeIconUrl || "",
    remixPrompt: htmlFile.remixPrompt || "",
    commentPresets: Array.isArray(m.commentPresets) ? m.commentPresets : [],
    mentions: Array.isArray(content.mentions) ? content.mentions : [],
    liked: !!inter.isLiked,
    collected: !!inter.isCollected,
    muted: !!inter.isMuted,
    raw: m.__raw || m,
  };
}

function parseComment(raw) {
  const wrap = raw && typeof raw === "object" ? raw : {};
  const c = wrap.comment || wrap.commentCard || wrap;
  const author = c.author || {};
  const base = author.userBase || author;
  const content = c.content || {};
  const stat = c.stat || {};
  const inter = c.interactionStatus || {};
  return {
    id: c.id || c.commentId || "",
    momentId: c.momentId || "",
    authorId: base.userId || author.userId || "",
    authorName: base.name || author.name || "",
    avatar: (base.avatarImage && (base.avatarImage.url || base.avatarImage.thumbnailUrl)) || "",
    text: typeof content.text === "string" ? content.text : "",
    like: stat.likeNum ?? stat.likeCount ?? 0,
    subNum: c.subCommentNum ?? stat.replyNum ?? 0,
    time: c.createTime || "",
    isBot: c.type === "COMMENT_TYPE_BOT",
    ai: c.aiGenerated === true,
    liked: !!inter.isLiked,
    sub: Array.isArray(c.subComments) ? c.subComments : [],
    subToken: c.subCommentPageToken || "",
    subIsLast: !!c.subCommentIsLastPage,
    mine: !!myId() && (base.userId || author.userId) === myId(),
    raw: c,
  };
}

function parseUser(raw) {
  const wrap = raw && typeof raw === "object" ? raw : {};
  const info = wrap.userInfo || wrap.user || {};
  const base = wrap.userBase || info.userBase || info.base || wrap.base || {};
  const stat = wrap.userStat || info.userStat || wrap.stat || {};
  const rel = wrap.interactionStatus || wrap.relationStatus
    || info.interactionStatus || info.relationStatus || {};
  return {
    id: base.userId || "",
    name: base.name || "",
    bio: base.bio || "",
    avatar: (base.avatarImage && (base.avatarImage.url || base.avatarImage.thumbnailUrl)) || "",
    follower: stat.followerNum ?? stat.followerCount ?? 0,
    following: stat.followingNum ?? stat.followingCount ?? 0,
    momentCount: stat.momentNum ?? stat.momentCount ?? 0,
    liked: stat.momentLikesNum ?? 0,
    isFollowing: /FOLLOWING|MUTUAL/.test(rel.followStatus || "") || !!rel.isFollowing,
    isMutual: rel.followStatus === E.FS_MUTUAL || !!rel.isMutualFollowing,
    isFollowedBy: rel.followStatus === E.FS_FOLLOWED || !!rel.isFollowedBy,
    isBlocked: rel.blockStatus === E.BLOCKED || !!rel.isBlocked,
    isMe: false,
    raw: wrap,
  };
}

function parseHashtag(raw) {
  const h = (raw && (raw.hashtag || raw)) || {};
  const icon = h.icon || {};
  return {
    id: String(h.id || ""),
    name: h.name || "",
    desc: h.description || h.desc || "",
    count: Number(h.momentNum ?? h.momentCount ?? h.count ?? 0) || 0,
    icon: icon.url || "",
    isAdmin: h.type === "HASHTAG_TYPE_ADMIN",
    raw: h,
  };
}

// 官方 Notification：{ id, notificationType, momentId, commentId,
//   happenedTime, readTime, fromUsers[] }
// ⚠️ fromUsers 是 userId 字符串数组，昵称从响应里的 users[] 查
function parseNotification(raw, idx) {
  const n = (raw && (raw.notification || raw)) || {};
  const lut = idx || {};
  const usersById = lut.users || {};
  const cmtsById = lut.comments || {};

  const ids = (Array.isArray(n.fromUsers) ? n.fromUsers : []).map(x =>
    typeof x === "string" ? x : (x && (x.userId || (x.userBase && x.userBase.userId))) || ""
  ).filter(Boolean);

  const firstId = ids[0] || "";
  const ub = usersById[String(firstId)] || null;
  const name = ub ? (ub.name || "") : "";

  return {
    id: n.id || "",
    type: n.notificationType || n.type || "",
    userId: firstId,
    userIds: ids,
    userName: name,
    userCount: ids.length,
    shortId: firstId ? firstId.slice(0, 8) : "",
    avatar: ub ? ((ub.avatarImage && (ub.avatarImage.url || ub.avatarImage.thumbnailUrl)) || "") : "",
    momentId: n.momentId || "",
    commentId: n.commentId || "",
    commentText: cmtsById[String(n.commentId)] || "",
    momentTitle: (() => {
      const mm = (lut.moments || {})[String(n.momentId)];
      if (!mm) return "";
      return (mm.content && mm.content.title) || mm.title || "";
    })(),
    time: n.happenedTime || n.time || "",
    read: !!n.readTime,
    raw: n,
  };
}

function buildNotifIndex(d) {
  const users = Object.create(null);
  const list = Array.isArray(d && d.users) ? d.users : [];
  list.forEach(u => {
    if (!u) return;
    const base = u.userBase || u;
    const id = base.userId || u.userId || "";
    if (id) users[String(id)] = base;
  });

  const cmts = Object.create(null);
  (Array.isArray(d && d.comments) ? d.comments : []).forEach(c => {
    if (!c) return;
    const cc = c.comment || c;
    const id = cc.id || c.id || "";
    if (!id) return;
    const txt = (cc.content && cc.content.text) || cc.text || "";
    if (txt) cmts[String(id)] = txt;
  });

  const moms = Object.create(null);
  (Array.isArray(d && d.moments) ? d.moments : []).forEach(m => {
    if (!m) return;
    const mm = m.moment || m;
    const id = mm.id || m.id || "";
    if (id) moms[String(id)] = mm;
  });

  return { users, comments: cmts, moments: moms };
}

// 官方 NOTIFICATION_TYPE_* → 中文动作
function notifAction(type) {
  const map = {
    NOTIFICATION_TYPE_UP_MOMENT: "赞了你的动态",
    NOTIFICATION_TYPE_UP_COMMENT: "赞了你的评论",
    NOTIFICATION_TYPE_COMMENT_MOMENT: "评论了你的动态",
    NOTIFICATION_TYPE_REPLY_COMMENT: "回复了你的评论",
    NOTIFICATION_TYPE_FAVORITE: "收藏了你的动态",
    NOTIFICATION_TYPE_FOLLOW: "关注了你",
    NOTIFICATION_TYPE_MY_KIMI: "提到了你",
    NOTIFICATION_TYPE_ACTIVITY: "活动通知",
    NOTIFICATION_TYPE_OPERATIONAL: "运营通知",
    NOTIFICATION_TYPE_TASK: "任务通知",
    NOTIFICATION_TYPE_SKILL: "技能通知",
    NOTIFICATION_TYPE_CHAT_STATUS_CHANGED: "会话状态变化",
  };
  return map[type] || type || "有新动态";
}

function bodyOf(p) {
  if (p.excerpt) return highlightMentions(p.excerpt, p.mentions);
  if (p.segments && p.segments.length) {
    return esc(p.segments.map(s => splitMarkdownHtml(s && s.text).plain).join("\n\n").trim());
  }
  return "";
}

// ══════════════════════════════════════════
//  组件
// ══════════════════════════════════════════
function emptyHintHtml(p) {
  return `<div class="c-empty">
    这条动态没有可显示的正文或图片
    <span class="c-empty-why">（type=${esc(p.isChatPost ? "CHAT" : "未知")}，未返回网页数据）</span>
    <span class="c-empty-retry" data-reload="${esc(p.id)}">重新拉取</span>
  </div>`;
}

function cardHtml(p, showRaw) {
  const name = p.authorName || "匿名";
  const body = bodyOf(p);
  const long = body.length > 220;
  const isWeb = !!(p.htmlUrl || p.htmlCode);

  let tagHtml = "";
  if (p.hashtags.length) {
    tagHtml = '<div class="c-tags">' + p.hashtags.slice(0, 4)
      .map(t => `<span class="tag" data-tag="${esc(t.id || t.name || "")}">#${esc(t.name || t.hashtagName || t)}</span>`)
      .join("") + "</div>";
  }

  // 图组：1 张大图，2 张并排，3 张及以上九宫格
  let cover = "";
  if (p.isImagePost && p.images && p.images.length) {
    const imgs = p.images.slice(0, 9);
    const n = imgs.length;
    const cls = n === 1 ? "imgs one" : (n === 2 ? "imgs two" : "imgs grid");
    cover = `<div class="${cls}">` + imgs.map((im, i) =>
      `<div class="img-cell" data-img="${esc(im.full)}" data-idx="${i}">
         <img src="${esc(im.thumb || im.full)}" loading="lazy" alt=""
              referrerpolicy="no-referrer"
              onerror="this.parentNode.classList.add('broken')">
       </div>`).join("") + "</div>";
    if (p.images.length > 9) {
      cover += `<div class="img-more">共 ${p.images.length} 张</div>`;
    }
  } else if (p.cover) {
    const full = p.coverFull || p.cover;
    cover = `<div class="c-cover"${p.coverColor ? ` style="background:${esc(p.coverColor)}"` : ""}
         data-img="${esc(full)}" title="点击查看完整封面">
         <img src="${esc(p.cover)}" loading="lazy" alt=""
              referrerpolicy="no-referrer"
              onerror="this.style.visibility='hidden'"></div>`;
  }

  const noBody = !body && !p.title && !cover && !(p.images && p.images.length);

  return `<div class="card" data-id="${esc(p.id)}" data-uid="${esc(p.authorId)}"
            data-name="${esc(name)}">
    <div class="c-head">
      ${avatarHtml(name, p.avatar)}
      <div class="c-name">
        <a class="u-link" href="#/user/${esc(p.authorId)}">${esc(name)}</a>
        ${isWeb || p.isChatPost ? '<span class="badge web">网页</span>' : ""}
        ${p.isImagePost ? '<span class="badge img">图片</span>' : ""}
      </div>
      <div class="c-time">${esc(fmtTime(p.time))}</div>
    </div>
    ${p.title ? `<div class="c-title">${esc(p.title)}</div>` : ""}
    ${body ? `<div class="c-text${long ? " clamp" : ""}">${body}</div>` : ""}
    ${long ? '<div class="c-more">展开全文</div>' : ""}
    ${tagHtml}${cover}
    ${noBody ? emptyHintHtml(p) : ""}
    <div class="c-foot">
      <span class="act${p.liked ? " on" : ""}" data-like="1">${ICON.like} ${esc(num(p.like))}</span>
      <span class="act" data-cmt="1">${ICON.cmt} ${esc(num(p.comment))}</span>
      <span class="act${p.collected ? " on" : ""}" data-fav="1">${ICON.star} ${esc(num(p.collect))}</span>
      <span class="act c-more-act" data-menu="1">${ICON.more}</span>
    </div>
    ${showRaw ? rawBlock(p.raw, "原始 JSON") : ""}
  </div>`;
}

function userRowHtml(u, extra) {
  return `<div class="u-row" data-uid="${esc(u.id)}" data-name="${esc(u.name)}">
    ${avatarHtml(u.name, u.avatar)}
    <div class="u-main">
      <a class="u-name" href="#/user/${esc(u.id)}">${esc(u.name || "未知用户")}</a>
      ${u.bio ? `<div class="u-bio">${esc(u.bio)}</div>` : ""}
      <div class="u-stat">
        <span>粉丝 <b>${esc(num(u.follower))}</b></span>
        <span>动态 <b>${esc(num(u.momentCount))}</b></span>
      </div>
    </div>
    <div class="u-ops">${extra || ""}</div>
  </div>`;
}

function hashtagRowHtml(h) {
  return `<div class="h-row" data-hid="${esc(h.id)}" data-hname="${esc(h.name)}">
    <div class="h-main">
      <div class="h-name">#${esc(h.name)}</div>
      ${h.desc ? `<div class="h-desc">${esc(h.desc)}</div>` : ""}
    </div>
    <div class="h-count">${esc(num(h.count))} 条</div>
  </div>`;
}

function notifHtml(n) {
  const who = n.userName || (n.shortId ? "用户 " + n.shortId : "未知");
  const act = notifAction(n.type);
  const more = n.userCount > 1 ? `<span class="n-more">等 ${n.userCount} 人</span>` : "";
  const mid = n.momentId || "";
  const mom = n.momentTitle
    ? `<div class="n-mom"><span class="n-mom-k">我的动态</span>${esc(n.momentTitle)}</div>`
    : "";
  const txt = n.commentText ? `<div class="n-txt">${esc(n.commentText)}</div>` : "";
  return `<div class="n-row${n.read ? "" : " unread"}" data-nid="${esc(n.id)}"
            data-uid="${esc(n.userId)}" data-name="${esc(who)}"
            ${mid ? `data-mid="${esc(mid)}"` : ""}>
    ${avatarHtml(who, n.avatar, "sm")}
    <div class="n-main">
      <div class="n-top"><b>${esc(who)}</b>${more}<span class="n-act">${esc(act)}</span></div>
      ${mom}${txt}
      <div class="n-time">${esc(fmtTime(n.time))}${n.read ? "" : " · 未读"}</div>
    </div>
    ${rawBlock(n.raw, "原始 JSON")}
  </div>`;
}

// ══════════════════════════════════════════
//  通用分页列表
// ══════════════════════════════════════════
async function loadPage(key, fetcher, renderer, opts = {}) {
  const st = listState(key);
  if (st.loading) return;
  st.loading = true;
  const append = !!opts.append;

  const box = () => (opts.container ? $(opts.container) : $("#view"));
  const active = () => {
    if (!box()) return false;
    if (opts.container) return true;
    return !!(S.route && S.route.key === key);
  };
  if (!append && active()) {
    box().innerHTML = skel(opts.skel || 4);
  }

  // 非追加 = 全新加载，必须从头开始。
  // 之前不清游标，会带着上次滚动残留的 token 去请求，
  // 表现就是：第二次进个人主页看到的是"八百年前"的旧动态。
  if (!append) { st.token = ""; st.items = []; }

  try {
    const { items, token } = await fetcher(st.token, append);
    st.token = token || "";
    st.loaded = true;
    if (append) {
      st.items = st.items.concat(items);
      if (active()) {
        box().insertAdjacentHTML("beforeend", items.map(renderer).join(""));
        bindDynamic(); bindRawToggle();
      }
    } else {
      st.items = items;
      if (active()) renderItems(items, renderer, opts.empty, opts.container);
    }
  } catch (e) {
    st.loaded = true;
    if (active()) {
      box().innerHTML = `<div class="err">加载失败：${esc(e.message)}</div>`;
    }
  } finally {
    st.loading = false;
  }
}

function renderItems(items, renderer, emptyMsg, container) {
  const box = container ? $(container) : $("#view");
  if (!box) return;
  if (!items.length) {
    box.innerHTML = `<div class="empty">${emptyMsg || "这里什么都没有"}</div>`;
    bindDynamic(); bindRawToggle();
    return;
  }
  box.innerHTML = items.map(renderer).join("");
  bindDynamic();
  bindRawToggle();
}

// ══════════════════════════════════════════
//  视图：信息流（推荐 / 关注）
// ══════════════════════════════════════════
async function viewFeed(kind) {
  const key = kind === "mine" ? "mine" : "feed";
  const category = kind === "mine" ? E.FEED_FOLLOW : E.FEED_RECOMMEND;

  let uid = "";
  if (kind === "mine") {
    try {
      const me = S.me || (S.me = await read("moment.v1.UserService/GetMe", { view: E.VIEW_FULL }));
      uid = myIdFrom(me);
    } catch (e) { /* 取不到就空着 */ }
  }

  const st = listState(key);
  if (st.loaded && st.items.length && S.route && S.route.key === key) {
    renderItems(st.items, cardHtml, kind === "mine" ? "关注的人还没发动态" : "没有内容");
    return;
  }

  await loadPage(key, async (token) => {
    const body = { pageSize: 20, category };
    if (kind === "mine" && uid) body.userId = uid;
    if (token) body[PT] = token;
    const d = await read("moment.v1.FeedService/ListFeeds", body);
    const items = pickList(d, "moment.v1.FeedService/ListFeeds")
      .map(f => (f && f.moment) || f)
      .map(parseMoment).filter(x => x.id || x.title || x.excerpt);
    items.forEach(x => { if (x.id) S.cache[x.id] = x; });
    return { items, token: d[NPT] || "" };
  }, cardHtml, { empty: "没有内容", skel: 4 });
}

// ══════════════════════════════════════════
//  视图：搜索
// ══════════════════════════════════════════
let searchTab = "moment";

async function viewSearch() {
  const q = (S.route && S.route.q) || "";
  $("#view").innerHTML = `
    <div class="search-bar">
      <input id="qInput" placeholder="搜动态 / 用户 / 话题" value="${esc(q)}" autocomplete="off">
      <button id="qBtn">搜索</button>
    </div>
    <div class="seg-tabs">
      <button class="s-tab${searchTab === "moment" ? " on" : ""}" data-s="moment">动态</button>
      <button class="s-tab${searchTab === "user" ? " on" : ""}" data-s="user">用户</button>
      <button class="s-tab${searchTab === "hashtag" ? " on" : ""}" data-s="hashtag">话题</button>
    </div>
    <div id="sugBox" class="sug-box" style="display:none"></div>
    <div id="hotBox"></div>
    <div id="resultBox"></div>`;

  const inp = $("#qInput");
  const run = () => {
    const v = inp.value.trim();
    if (!v) { toast("输入点什么再搜"); return; }
    const next = "#/search/" + encodeURIComponent(v);
    if (location.hash === next) {
      const st = listState(searchKey(v));
      st.token = ""; st.items = []; st.loaded = false; st.kind = searchTab;
      renderSearchResult(v);
      return;
    }
    location.hash = next;
  };
  $("#qBtn").onclick = run;
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });

  // 输入联想：SuggestSearchQuery（防抖 300ms）
  let sugT = null;
  inp.addEventListener("input", () => {
    clearTimeout(sugT);
    const v = inp.value.trim();
    const box = $("#sugBox");
    if (!box) return;
    if (!v) { box.innerHTML = ""; box.style.display = "none"; return; }
    sugT = setTimeout(async () => {
      try {
        const d = await read("moment.v1.SearchService/SuggestSearchQuery", { query: v, count: 10 });
        const list = pickList(d, "moment.v1.SearchService/SuggestSearchQuery")
          .map(x => (typeof x === "string" ? x : (x && x.suggestedQuery)))
          .filter(Boolean);
        if (!list.length) { box.style.display = "none"; return; }
        box.innerHTML = list.map(s =>
          `<a class="sug-item" href="#/search/${encodeURIComponent(s)}">${esc(s)}</a>`).join("");
        box.style.display = "block";
      } catch (e) { box.style.display = "none"; }
    }, 300);
  });

  $$(".s-tab").forEach(b => {
    b.onclick = () => {
      searchTab = b.dataset.s;
      $$(".s-tab").forEach(x => x.classList.toggle("on", x.dataset.s === searchTab));
      if (q) {
        const st = listState(searchKey(q));
        st.token = ""; st.items = []; st.loaded = false; st.kind = searchTab;
      }
      renderSearchResult(q);
    };
  });

  // 热搜话题榜
  try {
    const d = await read("moment.v1.SearchService/ListHotHashtagsInSearch", {});
    const tags = pickList(d, "moment.v1.SearchService/ListHotHashtagsInSearch")
      .map(unwrap).map(parseHashtag);
    if (tags.length) {
      $("#hotBox").innerHTML = `<div class="sec-hd">${ICON.fire} 热搜话题</div>
        <div class="hot-list">${tags.map(t =>
          `<a class="hot-tag" href="#/hashtag/${esc(t.id || t.name)}">#${esc(t.name)}</a>`).join("")}</div>`;
    }
  } catch (e) { /* 热搜拿不到就算了 */ }

  if (q) renderSearchResult(q);
}

function searchKey(q) { return "search_" + searchTab + "_" + q; }

async function renderSearchResult(q) {
  if (!q) return;
  const key = searchKey(q);
  const st = listState(key);
  if (st.loaded && st.items.length && st.kind === searchTab) {
    renderItems(st.items, searchRenderer(), searchEmptyMsg(), "#resultBox");
    return;
  }
  st.token = ""; st.items = []; st.loaded = false; st.kind = searchTab;

  await loadPage(key, async (token) => {
    const body = { query: q, pageSize: 20 };
    if (token) body[PT] = token;
    if (searchTab === "user") {
      const d = await read("moment.v1.SearchService/SearchUsers", body);
      const items = pickList(d, "moment.v1.SearchService/SearchUsers")
        .map(unwrap).map(parseUser);
      return { items, token: d[NPT] || "" };
    }
    if (searchTab === "hashtag") {
      const d = await read("moment.v1.SearchService/SearchHashtags", body);
      const items = pickList(d, "moment.v1.SearchService/SearchHashtags")
        .map(unwrap).map(parseHashtag);
      return { items, token: d[NPT] || "" };
    }
    const d = await read("moment.v1.SearchService/SearchMoments", body);
    const items = pickList(d, "moment.v1.SearchService/SearchMoments")
      .map(unwrap).map(parseMoment);
    items.forEach(x => { if (x.id) S.cache[x.id] = x; });
    return { items, token: d[NPT] || "" };
  }, searchRenderer(), { empty: searchEmptyMsg(), skel: 3, container: "#resultBox" });
}

function searchRenderer() {
  if (searchTab === "user") return u => userRowHtml(u, followBtnHtml(u));
  if (searchTab === "hashtag") return hashtagRowHtml;
  return cardHtml;
}
function searchEmptyMsg() {
  if (searchTab === "user") return "没搜到用户";
  if (searchTab === "hashtag") return "没搜到话题";
  return "没搜到动态";
}

function followBtnHtml(u) {
  if (!u.id) return "";
  const mine = myId();
  if (mine && u.id === mine) return '<span class="u-mine">本人</span>';
  return `<button class="f-btn${u.isFollowing ? " on" : ""}" data-follow="${esc(u.id)}">
    ${u.isFollowing ? "已关注" : "关注"}</button>`;
}

// ══════════════════════════════════════════
//  视图：通知
// ══════════════════════════════════════════
async function viewNotify() {
  await loadPage("notify", async (cursor) => {
    const body = { limit: 30 };
    if (cursor) body.idLt = cursor;
    const d = await read("moment.v1.NotificationService/ListNotification", body);
    const idx = buildNotifIndex(d);
    const items = (d.notifications || []).map(n => parseNotification(n, idx));
    const last = items.length ? items[items.length - 1].id : "";
    const token = (items.length >= 30 && last) ? last : "";
    return { items, token };
  }, notifHtml, { empty: "还没有通知" });

  fillNotifNames();

  // 标记已读：MarkReadRequest 只有 idLte
  try {
    const st = S.lists.notify;
    const ids = (st && st.items ? st.items : []).map(x => x.id).filter(Boolean);
    if (ids.length) {
      const maxId = ids.reduce((a, b) => {
        const la = a.length, lb = b.length;
        if (la !== lb) return la > lb ? a : b;
        return a > b ? a : b;
      });
      await write("moment.v1.NotificationService/MarkRead", { idLte: maxId });
    }
  } catch (e) { /* 忽略 */ }
}

// 通知里查不到昵称的，按 userId 补一次资料并回填 DOM
async function fillNotifNames() {
  const st = S.lists.notify;
  if (!st || !st.items) return;
  const todo = [];
  st.items.forEach(n => {
    if (n.userName || !n.userId) return;
    if (S.userCache[n.userId]) return;
    if (todo.includes(n.userId)) return;
    todo.push(n.userId);
  });
  if (!todo.length) return;

  const batch = todo.slice(0, 12);
  await Promise.all(batch.map(async (uid) => {
    try {
      const d = await read("moment.v1.UserService/GetUserProfile", { userId: uid });
      const u = parseUser(d);
      if (u.id || u.name) S.userCache[uid] = u;
    } catch (e) { /* 单个失败不影响其他 */ }
  }));

  st.items.forEach(n => {
    if (n.userName || !n.userId) return;
    const u = S.userCache[n.userId];
    if (!u) return;
    n.userName = u.name || "";
    n.avatar = u.avatar || n.avatar;
    let row = null;
    if (window.CSS && CSS.escape) {
      row = document.querySelector(`#view .n-row[data-uid="${CSS.escape(n.userId)}"]`);
    } else {
      row = Array.from(document.querySelectorAll("#view .n-row"))
        .find(el => el.dataset.uid === n.userId);
    }
    if (!row) return;
    const b = row.querySelector(".n-top b");
    if (b && n.userName) b.textContent = n.userName;
    const img = row.querySelector("img");
    if (img && n.avatar) img.src = n.avatar;
  });
}

// ══════════════════════════════════════════
//  视图：用户主页（含我的主页）
// ══════════════════════════════════════════
async function viewUser(id) {
  $("#view").innerHTML = skel(3);
  let u = null;
  try {
    const mine = myId();
    if (mine && id === mine) {
      const me = S.me || (S.me = await read("moment.v1.UserService/GetMe", { view: E.VIEW_FULL }));
      u = parseUser(me); u.isMe = true;
    } else if (S.userCache[id]) {
      u = S.userCache[id];
    } else {
      const d = await read("moment.v1.UserService/GetUserProfile", { userId: id });
      u = parseUser(d);
      S.userCache[id] = u;
    }
  } catch (e) {
    $("#view").innerHTML = `<div class="err">加载主页失败：${esc(e.message)}</div>`;
    return;
  }

  const ops = u.isMe
    ? `<a class="p-btn" href="#/follows/${esc(u.id)}">我的关注</a>
       <a class="p-btn" href="#/block">屏蔽名单</a>`
    : (() => {
        const inLocal = (S.block || []).some(x => (x.userId || "") === u.id);
        const blocked = !!u.isBlocked || inLocal;
        return `<button class="p-btn${u.isFollowing ? " on" : ""}" id="btnFollow">${u.isFollowing ? "已关注" : "关注"}</button>
       <button class="p-btn${blocked ? " danger" : ""}" id="btnBlockUser">${blocked ? "解除拉黑" : "拉黑"}</button>
       <a class="p-btn" href="#/follows/${esc(u.id)}">TA 的关注</a>`;
      })();

  $("#view").innerHTML = `
    <a class="back" href="javascript:history.back()">${ICON.prev} 返回</a>
    <div class="profile">
      ${avatarHtml(u.name, u.avatar, "lg")}
      <div class="p-info">
        <div class="p-name">${esc(u.name || "未知用户")}${u.isMe ? '<span class="badge web">我</span>' : ""}
          ${u.isMutual ? '<span class="badge">互相关注</span>' : (u.isFollowedBy ? '<span class="badge">关注了你</span>' : "")}
          ${u.isBlocked ? '<span class="badge bad">已拉黑</span>' : ""}</div>
        ${u.bio ? `<div class="p-bio">${esc(u.bio)}</div>` : ""}
        <div class="p-stat">
          <span>粉丝 <b>${esc(num(u.follower))}</b></span>
          <span>关注 <b>${esc(num(u.following))}</b></span>
          <span>动态 <b>${esc(num(u.momentCount))}</b></span>
          <span>获赞 <b>${esc(num(u.liked))}</b></span>
        </div>
      </div>
    </div>
    <div class="p-ops">${ops}</div>
    <div class="sec-hd">TA 的动态</div>
    <div id="uMoments">${skel(2)}</div>`;

  if ($("#btnFollow")) {
    $("#btnFollow").onclick = async () => {
      const b = $("#btnFollow");
      const on = b.classList.contains("on");
      try {
        await write("moment.v1.FollowService/ModifyFollow", {
          userId: u.id, action: on ? E.UNFOLLOW : E.FOLLOW,
        });
        b.classList.toggle("on", !on);
        b.textContent = !on ? "已关注" : "关注";
        u.isFollowing = !on;
        toast(!on ? "已关注" : "已取关");
      } catch (e) { toast("操作失败：" + e.message); }
    };
  }
  if ($("#btnBlockUser")) {
    $("#btnBlockUser").onclick = async () => {
      const b = $("#btnBlockUser");
      const inLocal = (S.block || []).some(x => (x.userId || "") === u.id);
      const blocked = !!u.isBlocked || inLocal;
      if (!blocked) {
        if (!confirm(`拉黑「${u.name}」？\n\n同时会加入本地屏蔽名单，他的内容不会再出现在你的页面上。`)) return;
        b.disabled = true;
        try {
          await write("moment.v1.FollowService/ModifyBlock", {
            userId: u.id, action: E.BLOCK,
          });
        } catch (e) { /* 服务端失败也要加本地名单 */ }
        await api("/api/block/add", { userId: u.id, name: u.name });
        u.isBlocked = true;
        b.textContent = "解除拉黑"; b.classList.add("danger");
        toast("已拉黑并加入本地屏蔽");
      } else {
        b.disabled = true;
        if (u.isBlocked) {
          try {
            await write("moment.v1.FollowService/ModifyBlock", {
              userId: u.id, action: E.UNBLOCK,
            });
          } catch (e) { /* 服务端失败也继续解除本地 */ }
        }
        await api("/api/block/del", { key: u.id });
        u.isBlocked = false;
        b.textContent = "拉黑"; b.classList.remove("danger");
        toast("已解除拉黑");
      }
      await refreshBlock();
      b.disabled = false;
    };
  }

  // TA 的动态（接滚动续加载，key 用 uMoments_<uid>）
  await loadPage("uMoments_" + u.id, async (token) => {
    const body = { pageSize: 20, category: E.FEED_USER_PUBLISH, userId: u.id };
    if (token) body[PT] = token;
    const d = await read("moment.v1.FeedService/ListFeeds", body);
    const items = pickList(d, "moment.v1.FeedService/ListFeeds")
      .map(f => (f && f.moment) || f)
      .map(parseMoment).filter(x => x.id || x.title || x.excerpt);
    items.forEach(x => { if (x.id) S.cache[x.id] = x; });
    return { items, token: d[NPT] || "" };
  }, cardHtml, { empty: "还没有发过动态", skel: 2, container: "#uMoments" });

  // 缓存整页 DOM（不含滚动位置），返回时直接还原，不重新请求
  S.userPage = { id: u.id, html: $("#view").innerHTML };
}

// 个人主页动态滚动续加载
async function viewUserAppend(id) {
  await loadPage("uMoments_" + id, async (token) => {
    const body = { pageSize: 20, category: E.FEED_USER_PUBLISH, userId: id };
    if (token) body[PT] = token;
    const d = await read("moment.v1.FeedService/ListFeeds", body);
    const items = pickList(d, "moment.v1.FeedService/ListFeeds")
      .map(f => (f && f.moment) || f)
      .map(parseMoment).filter(x => x.id || x.title || x.excerpt);
    items.forEach(x => { if (x.id) S.cache[x.id] = x; });
    return { items, token: d[NPT] || "" };
  }, cardHtml, { append: true, container: "#uMoments" });
  // 追加后同步缓存，返回时能看到已加载的全部
  if (S.userPage && S.userPage.id === id) S.userPage.html = $("#view").innerHTML;
}

async function viewFollows(id) {
  $("#view").innerHTML = skel(3);
  try {
    const d = await read("moment.v1.FollowService/ListFollows",
      { userId: id, followType: E.FOLLOWINGS, pageSize: 50 });
    const items = pickList(d, "moment.v1.FollowService/ListFollows")
      .map(unwrap).map(parseUser);
    $("#view").innerHTML = `<a class="back" href="javascript:history.back()">${ICON.prev} 返回</a>
      <div class="sec-hd">关注列表</div>`;
    const box = document.createElement("div");
    box.innerHTML = items.length ? items.map(u => userRowHtml(u, followBtnHtml(u))).join("")
      : `<div class="empty">还没有关注任何人</div>`;
    $("#view").appendChild(box);
    bindDynamic();
  } catch (e) {
    $("#view").innerHTML = `<div class="err">加载失败：${esc(e.message)}</div>`;
  }
}

// ══════════════════════════════════════════
//  视图：话题页
// ══════════════════════════════════════════
async function viewHashtag(idOrName) {
  $("#view").innerHTML = skel(3);
  let h = null;
  try {
    const d = await read("moment.v1.HashtagService/GetHashtag", { id: idOrName });
    h = parseHashtag(d);
  } catch (e) { h = { id: idOrName, name: idOrName, count: 0 }; }

  $("#view").innerHTML = `
    <a class="back" href="javascript:history.back()">${ICON.prev} 返回</a>
    <div class="h-head">
      ${h.icon ? `<img class="h-icon" src="${esc(h.icon)}" alt="" referrerpolicy="no-referrer"
                    onerror="this.style.display='none'">` : ""}
      <div class="h-head-main">
        <div class="h-title">#${esc(h.name || idOrName)}
          ${h.isAdmin ? '<span class="badge web">官方</span>' : ""}</div>
        ${h.count ? `<div class="h-stat">${esc(num(h.count))} 条动态</div>` : ""}
      </div>
    </div>
    ${h.desc ? `<div class="h-desc2">${esc(h.desc)}</div>` : ""}
    <div id="hList">${skel(3)}</div>`;

  // 相关话题（ListHashtags）
  try {
    const d = await read("moment.v1.HashtagService/ListHashtags", {});
    const rel = [
      ...(Array.isArray(d.topUpHashtags) ? d.topUpHashtags : []),
      ...(Array.isArray(d.recentUsedHashtags) ? d.recentUsedHashtags : []),
      ...(Array.isArray(d.allHashtags) ? d.allHashtags : []),
    ].map(unwrap).map(parseHashtag)
      .filter(t => t.name && t.name !== h.name).slice(0, 8);
    if (rel.length) {
      $("#hList").insertAdjacentHTML("beforebegin",
        `<div class="sec-hd">相关话题</div>
         <div class="hot-list">${rel.map(t =>
           `<a class="hot-tag" href="#/hashtag/${esc(t.id || t.name)}">#${esc(t.name)}</a>`).join("")}</div>`);
    }
  } catch (e) { /* 拿不到就算了 */ }

  try {
    const d = await read("moment.v1.FeedService/ListFeeds", {
      pageSize: 20, category: E.FEED_HASHTAG, hashtagId: h.id || idOrName,
    });
    const items = pickList(d, "moment.v1.FeedService/ListFeeds")
      .map(f => (f && f.moment) || f)
      .map(parseMoment).filter(x => x.id || x.title || x.excerpt);
    items.forEach(x => { if (x.id) S.cache[x.id] = x; });
    $("#hList").innerHTML = items.length ? items.map(cardHtml).join("")
      : `<div class="empty">这个话题下还没有动态</div>`;
    bindDynamic();
  } catch (e) {
    $("#hList").innerHTML = `<div class="err">加载失败：${esc(e.message)}</div>`;
  }
}

// ══════════════════════════════════════════
//  视图：动态详情
// ══════════════════════════════════════════
async function fetchMoment(id) {
  if (S.cache[id]) return S.cache[id];
  try {
    const d = await read("moment.v1.FeedService/GetFeed",
      { feedType: E.FEED_TYPE_MOMENT, feedId: id });
    const feed = d.feed || {};
    const m = feed.moment || d.moment || d;
    if (m && (m.id || m.content)) {
      if (Array.isArray(feed.commentPresets) && !m.commentPresets) {
        m.commentPresets = feed.commentPresets;
      }
      const p = parseMoment({ moment: m });
      if (p.id) { S.cache[p.id] = p; return p; }
    }
  } catch (e) { /* 回退到列表 */ }
  for (const k of Object.keys(S.lists)) {
    const hit = (S.lists[k].items || []).find(x => x.id === id);
    if (hit) return hit;
  }
  return null;
}

async function viewMoment(id) {
  $("#view").innerHTML = skel(3);
  const p = await fetchMoment(id);
  if (!p) {
    $("#view").innerHTML = `<div class="empty">打不开这条动态<br>
      <span style="font-size:12px">直接刷新详情页会丢缓存，先从列表点进来</span>
      <div style="margin-top:14px">
        <a class="btn gray" href="#/feed" style="width:auto;padding:8px 16px;text-decoration:none">← 回推荐</a>
      </div></div>`;
    return;
  }

  let segs = "";
  if (p.segments && p.segments.length) {
    segs = p.segments.map(s => {
      const role = s.role === "CHAT_ROLE_ASSISTANT" ? "AI"
        : (s.role === "CHAT_ROLE_USER" ? "我" : (s.role || ""));
      let plain = splitMarkdownHtml(s && s.text).plain.trim();
      if (p.htmlUrl || p.htmlCode) plain = plain.replace(/\[(网页预览|HTML 预览)[^\]]*\]/g, "").trim();
      if (!plain) return "";
      return `<div class="seg">
        ${role ? `<div class="seg-role">${esc(role)}</div>` : ""}
        <div class="seg-text">${esc(plain)}</div></div>`;
    }).join("");
  }

  let webHtml = "";
  if (p.htmlUrl || p.htmlCode) {
    const srcAttr = p.htmlUrl
      ? `src="${esc(p.htmlUrl)}" data-mode="src"`
      : `data-mode="srcdoc" data-code="${esc(p.htmlCode)}"`;
    webHtml = `<div class="web-box">
      <div class="web-bar">
        <span class="web-dot"></span><span class="web-dot"></span><span class="web-dot"></span>
        <span class="web-t">${esc(p.title || "网页预览")}</span>
        <button class="web-btn" id="webReload">${ICON.reload}</button>
        ${p.remixPrompt ? `<button class="web-btn" id="webRemix">${ICON.spark} Remix</button>` : ""}
        <button class="web-btn" id="webNew">${ICON.ext} 新窗口</button>
        <button class="web-btn" id="webClose">${ICON.up} 收起</button>
      </div>
      <div class="web-stage">
        <iframe id="webFrame" class="web-frame" ${srcAttr}
          sandbox="allow-scripts allow-popups allow-forms"
          referrerpolicy="no-referrer"></iframe>
      </div>
      ${p.notice ? `<div class="web-note">
        ${p.noticeIcon ? `<img class="note-ic" src="${esc(p.noticeIcon)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ""}
        ${esc(p.notice)}</div>` : ""}
    </div>`;
  }

  // 详情页：图片帖显示原图（不限宽度，按真实比例）
  let imagesHtml = "";
  if (p.images && p.images.length) {
    imagesHtml = `<div class="imgs detail">` + p.images.map((im, i) =>
      `<div class="img-cell" data-img="${esc(im.full)}" data-idx="${i}">
         <img src="${esc(im.full || im.thumb)}" loading="lazy" alt=""
              referrerpolicy="no-referrer"
              onerror="this.parentNode.classList.add('broken')">
       </div>`).join("") + "</div>";
  }

  const mine = myId();
  const isMine = mine && p.authorId === mine;

  $("#view").innerHTML = `
    <a class="back" href="javascript:history.back()">${ICON.prev} 返回</a>
    <div class="card" style="cursor:default">
      <div class="c-head">
        ${avatarHtml(p.authorName, p.avatar)}
        <div class="c-name">
          <a class="u-link" href="#/user/${esc(p.authorId)}">${esc(p.authorName || "匿名")}</a>
          ${isMine ? `<span class="act c-del" data-del="1">${ICON.trash} 删除</span>` : ""}
        </div>
        <div class="c-time">${esc(fmtTime(p.time))}</div>
      </div>
      ${p.title ? `<div class="c-title">${esc(p.title)}</div>` : ""}
      ${imagesHtml}
      ${webHtml}
      ${p.excerpt ? `<div class="c-text">${highlightMentions(p.excerpt, p.mentions)}</div>` : ""}
      ${segs}
      ${!segs && !webHtml && !p.excerpt ? `<div class="c-empty">
        未拿到这条动态的完整内容
        <span class="c-empty-why">（响应里没有 segments / chatShareCard）</span>
        <span class="c-empty-retry" data-reload="${esc(p.id)}">重新拉取</span>
      </div>` : ""}
      ${p.hashtags.length ? `<div class="c-tags">${p.hashtags.map(h =>
        `<a class="tag" href="#/hashtag/${esc(h.id || h.name || "")}">#${esc(h.name || h)}</a>`).join("")}</div>` : ""}
      <div class="c-foot">
        <span class="act${p.liked ? " on" : ""}" data-like="1">${ICON.like} ${esc(num(p.like))}</span>
        <span>${ICON.cmt} ${esc(num(p.comment))}</span>
        <span class="act${p.collected ? " on" : ""}" data-fav="1">${ICON.star} ${esc(num(p.collect))}</span>
        <span class="act c-more-act" data-menu="1">${ICON.more}</span>
      </div>
      <span class="raw-toggle">${ICON.caretR} 原始 JSON</span>
      <pre class="raw" style="display:none">${esc(JSON.stringify(p.raw, null, 2))}</pre>
    </div>
    <div class="sec-hd">评论</div>
    ${(p.commentPresets && p.commentPresets.length) ? `<div class="cmt-presets">
      ${p.commentPresets.slice(0, 6).map(cp =>
        `<span class="preset" data-preset="${esc((cp && cp.content) || cp || "")}">${esc((cp && cp.content) || cp || "")}</span>`).join("")}
    </div>` : ""}
    <div id="cmtList">${skel(2)}</div>
    <div class="cmt-send">
      <input id="cmtInput" placeholder="说点什么…" autocomplete="off">
      <button id="cmtSend">发送</button>
    </div>
    <div class="sec-hd">相似动态</div>
    <div id="simList"><div class="empty" style="padding:14px 0">—</div></div>`;

  bindWebFrame(p);
  bindRawToggle();
  bindDynamic();
  bindCommentInput(p);
  loadComments(p.id);
  loadSimilar(p.id);
}

function bindWebFrame(p) {
  const f = document.getElementById("webFrame");
  if (!f) return;
  if (f.dataset.mode === "srcdoc" && f.dataset.code) f.srcdoc = f.dataset.code;
  f.addEventListener("load", () => {
    setTimeout(() => {
      try {
        const h = f.contentDocument && f.contentDocument.body && f.contentDocument.body.scrollHeight;
        if (h && h > 100) f.style.height = Math.min(h + 20, 700) + "px";
      } catch (e) { /* 跨域读不到 */ }
    }, 400);
  });
  const r = $("#webReload"); if (r) r.onclick = () => { f.src = f.src; };
  const o = $("#webNew"); if (o) o.onclick = () => {
    if (p.htmlUrl) { window.open(p.htmlUrl, "_blank", "noopener"); return; }
    const w = window.open("", "_blank");
    if (w) { w.document.write(p.htmlCode || ""); w.document.close(); }
  };
  const c = $("#webClose"); if (c) c.onclick = () => {
    const mini = f.closest(".web-box").classList.toggle("mini");
    c.innerHTML = mini ? `${ICON.down} 展开` : `${ICON.up} 收起`;
    if (!mini) f.style.height = "";
  };

  // Remix：把官方的 remixPrompt 复制好并打开 Kimi
  const rm = $("#webRemix");
  if (rm) rm.onclick = async () => {
    const txt = p.remixPrompt || "";
    try {
      await navigator.clipboard.writeText(txt);
      toast("提示词已复制，去 Kimi 粘贴即可");
    } catch (e) { toast("复制失败，已在新窗口展示"); }
    window.open("https://www.kimi.com/", "_blank", "noopener");
  };
}

/** 点击是否落在"原始 JSON"区域（含空值保护） */
function isRawHit(e) {
  return !!(e && e.target && e.target.closest && e.target.closest(".raw-toggle, .raw"));
}

function bindRawToggle() {
  $$("#view .raw-toggle").forEach(t => {
    if (t.dataset.b) return;
    t.dataset.b = "1";
    // 记下初始文案（含图标），收起时还原
    if (!t.dataset.label) t.dataset.label = t.innerHTML;

    t.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const id = t.dataset.raw;
      let pre;
      if (id) pre = document.querySelector(`[data-raw-pre="${id}"]`);
      else pre = t.nextElementSibling;
      if (!pre || !pre.classList.contains("raw")) return;

      const show = pre.style.display === "none";
      if (show && !pre.dataset.filled && !pre.textContent.trim()) {
        const obj = id ? RAW_STORE[id] : null;
        if (obj !== undefined && obj !== null) {
          pre.textContent = JSON.stringify(obj, null, 2);
          pre.dataset.filled = "1";
        }
      }
      pre.style.display = show ? "block" : "none";
      t.innerHTML = show
        ? `${ICON.caretD} 收起 JSON`
        : (t.dataset.label || `${ICON.caretR} 原始 JSON`);
    };
  });
}

async function loadSimilar(id) {
  const box = $("#simList");
  if (!box) return;
  try {
    const d = await read("moment.v1.MomentService/ListSimilarMoments", { momentId: id, pageSize: 10 });
    const items = pickList(d, "moment.v1.MomentService/ListSimilarMoments")
      .map(parseMoment).filter(x => x.id);
    items.forEach(x => { S.cache[x.id] = x; });
    box.innerHTML = items.length ? items.map(p => cardHtml(p, true)).join("")
      : `<div class="empty" style="padding:14px 0">没有相似推荐</div>`;
    bindDynamic();
    bindRawToggle();
  } catch (e) {
    box.innerHTML = `<div class="empty" style="padding:14px 0">—</div>`;
  }
}

// ══════════════════════════════════════════
//  评论
// ══════════════════════════════════════════
async function loadComments(id) {
  const box = $("#cmtList");
  if (!box) return;
  try {
    const d = await read("moment.v1.CommentService/ListComments", { momentId: id, pageSize: 50 });
    const list = pickList(d, "moment.v1.CommentService/ListComments").map(parseComment);
    box.innerHTML = list.length ? list.map(c => cmtHtml(c, false)).join("")
      : `<div class="empty" style="padding:24px 0">还没有评论</div>`;
    bindComments({ id });
  } catch (e) {
    box.innerHTML = `<div class="err">评论加载失败：${esc(e.message)}</div>`;
  }
}

function cmtHtml(c, isSub) {
  const name = c.authorName || "匿名";
  const badge = (c.isBot ? '<span class="badge bot">BOT</span>' : "")
    + (c.ai ? '<span class="badge ai">AI</span>' : "");
  const sub = (c.sub && c.sub.length)
    ? `<div class="sub">${c.sub.map(s => cmtHtml(parseComment(s), true)).join("")}</div>` : "";
  const subTotal = Number(c.subNum || 0);
  const inlineCnt = (c.sub && c.sub.length) || 0;
  const needFetch = !isSub && subTotal > inlineCnt;

  let subHtml = sub;
  if (c.sub && c.sub.length > 2 && !isSub) {
    const head = c.sub.slice(0, 2);
    subHtml = `<div class="sub">${head.map(s => cmtHtml(parseComment(s), true)).join("")}</div>
      <div class="sub-more" data-sub="${esc(c.id)}"
           ${c.subToken ? `data-token="${esc(c.subToken)}"` : ""}>展开其余 ${c.sub.length - 2} 条回复</div>
      <div class="sub-rest" data-subrest="${esc(c.id)}" style="display:none">
        ${c.sub.slice(2).map(s => cmtHtml(parseComment(s), true)).join("")}</div>`;
  }
  const fetchMore = (needFetch && c.subToken)
    ? `<div class="sub-more" data-sub="${esc(c.id)}" data-token="${esc(c.subToken)}"
         data-mode="fetch">加载其余 ${subTotal - inlineCnt} 条回复</div>` : "";

  return `<div class="cmt" data-cid="${esc(c.id)}" data-uid="${esc(c.authorId)}"
            data-name="${esc(name)}">
    ${avatarHtml(name, c.avatar, "sm")}
    <div class="cmt-main">
      <div class="cmt-n">
        <a class="u-link" href="#/user/${esc(c.authorId)}">${esc(name)}</a>${badge}
      </div>
      <div class="cmt-t">${esc(c.text)}</div>
      <div class="cmt-f">
        <span class="act" data-reply="${esc(c.id)}">回复</span>
        <span class="act${c.liked ? " on" : ""}" data-clike="${esc(c.id)}">${ICON.like} ${esc(num(c.like))}</span>
        <span>${ICON.cmt} ${esc(num(c.subNum))}</span>
        <span>${esc(fmtTime(c.time))}</span>
        ${c.mine ? `<span class="act c-del" data-cdel="1">${ICON.trash} 删除</span>` : ""}
      </div>
      ${subHtml}${fetchMore}
    </div>
  </div>`;
}

function bindComments(p) {
  const mid = (p && p.id) || (() => {
    const c = document.querySelector("#view .card[data-id]");
    return c ? c.dataset.id : "";
  })();

  $$("#cmtList [data-reply]").forEach(el => {
    el.onclick = () => {
      const inp = $("#cmtInput");
      if (!inp) return;
      inp.dataset.reply = el.dataset.reply;
      inp.placeholder = "回复这条评论…";
      inp.focus();
    };
  });

  $$("#cmtList [data-clike]").forEach(el => {
    el.onclick = async () => {
      const on = el.classList.contains("on");
      try {
        await write("moment.v1.CommentService/VoteComment", {
          commentId: el.dataset.clike, voteAction: on ? E.CMT_CANCEL_LIKE : E.CMT_LIKE,
        });
        el.classList.toggle("on", !on);
        const n = parseInt((el.textContent.match(/\d+/) || [0])[0], 10);
        el.innerHTML = `${ICON.like} ${Math.max(0, n + (on ? -1 : 1))}`;
      } catch (e) { toast("操作失败：" + e.message); }
    };
  });

  $$("#cmtList .sub-more").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = async () => {
      const rest = document.querySelector(`[data-subrest="${el.dataset.sub}"]`);
      if (rest) { rest.style.display = "block"; el.style.display = "none"; return; }
      el.textContent = "加载中…";
      try {
        const body = { momentId: mid, rootCommentId: el.dataset.sub, count: 50 };
        if (el.dataset.token) body.pageToken = el.dataset.token;
        const d = await read("moment.v1.CommentService/ListSubComments", body);
        const list = pickList(d, "moment.v1.CommentService/ListSubComments")
          .map(unwrap).map(parseComment);
        if (d && d.nextPageToken) el.dataset.token = d.nextPageToken;
        const box = el.parentElement.querySelector(".sub") || el.parentElement;
        box.insertAdjacentHTML("beforeend",
          list.map(s => cmtHtml(s, true)).join(""));
        el.style.display = "none";
      } catch (err) { toast("加载失败：" + err.message); el.textContent = "重试"; }
    };
  });

  $$("#cmtList [data-cdel]").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = async (e) => {
      e.stopPropagation();
      const box = el.closest(".cmt");
      if (!box || !confirm("确定删除这条评论？")) return;
      try {
        await write("moment.v1.CommentService/DeleteComment",
          { commentId: box.dataset.cid });
        box.remove();
        toast("已删除");
      } catch (err) { toast("删除失败：" + err.message); }
    };
  });
}

function bindCommentInput(p) {
  const inp = $("#cmtInput"), btn = $("#cmtSend");
  if (!inp || !btn) return;
  btn.onclick = async () => {
    const txt = inp.value.trim();
    if (!txt) return;
    const body = { momentId: p.id, content: { text: txt } };
    if (inp.dataset.reply) body.targetCommentId = inp.dataset.reply;
    btn.disabled = true;
    try {
      await write("moment.v1.CommentService/CreateComment", body);
      inp.value = ""; delete inp.dataset.reply;
      inp.placeholder = "说点什么…";
      toast("已发送");
      loadComments(p.id);
    } catch (e) {
      toast("发送失败：" + e.message);
    } finally { btn.disabled = false; }
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); btn.click(); }
  });
}

// ══════════════════════════════════════════
//  动态交互（统一绑定，列表与详情共用）
// ══════════════════════════════════════════
function bindDynamic() {
  // 图片点击 → 放大查看
  $$("#view .img-cell").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = (e) => {
      e.stopPropagation();
      const src = el.dataset.img;
      if (!src) return;
      const box = el.closest(".imgs");
      const all = box ? Array.from(box.querySelectorAll(".img-cell"))
        .map(x => x.dataset.img).filter(Boolean) : [src];
      openLightbox(all, all.indexOf(src));
    };
  });

  // 封面点击 → 看完整原图
  $$("#view .c-cover").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = (e) => {
      e.stopPropagation();
      const src = el.dataset.img;
      if (src) openLightbox([src], 0);
    };
  });

  // 展开全文
  $$("#view .c-more").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = (e) => {
      e.stopPropagation();
      const t = el.previousElementSibling;
      t.classList.toggle("clamp");
      el.textContent = t.classList.contains("clamp") ? "展开全文" : "收起";
    };
  });

  // 点赞
  $$("#view [data-like]").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = async (e) => {
      e.stopPropagation();
      const card = el.closest(".card");
      const id = card && card.dataset.id;
      if (!id) return;
      const on = el.classList.contains("on");
      try {
        await write("moment.v1.MomentService/VoteMoment", {
          momentId: id, voteAction: on ? E.VOTE_CANCEL_LIKE : E.VOTE_LIKE,
        });
        el.classList.toggle("on", !on);
        const n = parseInt((el.textContent.match(/\d+/) || [0])[0], 10);
        el.innerHTML = `${ICON.like} ${Math.max(0, n + (on ? -1 : 1))}`;
        if (S.cache[id]) S.cache[id].liked = !on;
      } catch (err) { toast("操作失败：" + err.message); }
    };
  });

  // 收藏
  $$("#view [data-fav]").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = async (e) => {
      e.stopPropagation();
      const card = el.closest(".card");
      const id = card && card.dataset.id;
      if (!id) return;
      const on = el.classList.contains("on");
      try {
        await write(on ? "moment.v1.FavoriteService/DeleteFavorite" : "moment.v1.FavoriteService/CreateFavorite",
          { momentId: id });
        el.classList.toggle("on", !on);
        const n = parseInt((el.textContent.match(/\d+/) || [0])[0], 10);
        el.innerHTML = `${ICON.star} ${Math.max(0, n + (on ? -1 : 1))}`;
        toast(!on ? "已收藏" : "已取消收藏");
        if (S.cache[id]) S.cache[id].collected = !on;
      } catch (err) { toast("操作失败：" + err.message); }
    };
  });

  // 评论数 → 跳转详情
  $$("#view [data-cmt]").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = (e) => {
      e.stopPropagation();
      const card = el.closest(".card");
      if (card && card.dataset.id) location.hash = "#/moment/" + encodeURIComponent(card.dataset.id);
    };
  });

  // 更多菜单（不感兴趣 / 举报 / 删除）
  $$("#view [data-menu]").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = async (e) => {
      e.stopPropagation();
      const card = el.closest(".card");
      const id = card && card.dataset.id;
      if (!id) return;
      const uid = card.dataset.uid, nm = card.dataset.name;
      openMenu([
        { t: "不感兴趣", fn: async () => {
            try { await write("moment.v1.MuteService/Mute", { objectType: E.MUTE_MOMENT, objectId: id }); }
            catch (err) { toast("服务端失败，仅本地隐藏"); }
            await api("/api/block/add", { userId: uid, name: nm, objectId: id });
            toast("已隐藏该作者的内容"); card.remove();
          } },
        { t: "举报", fn: async () => {
            const reason = prompt("举报原因（可留空）：") || "";
            try {
              await write("moment.v1.ComplaintService/CreateComplaint",
                { objectType: E.COMPLAIN_MOMENT, objectId: id, reason });
              toast("已举报，平台会处理");
            } catch (err) { toast("举报失败：" + err.message); }
          } },
        { t: "复制原文链接", fn: () => {
            navigator.clipboard && navigator.clipboard.writeText(location.origin + location.pathname + "#/moment/" + id);
            toast("已复制");
          } },
      ], e);
    };
  });

  // 删除自己的动态
  $$("#view [data-del]").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = async (e) => {
      e.stopPropagation();
      const card = el.closest(".card");
      const id = card && card.dataset.id;
      if (!id || !confirm("确定删除这条动态？")) return;
      try {
        await write("moment.v1.MomentService/DeleteMoment", { momentId: id });
        toast("已删除");
        location.hash = "#/me";
      } catch (err) { toast("删除失败：" + err.message); }
    };
  });

  // 关注按钮
  $$("#view [data-follow]").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = async (e) => {
      e.stopPropagation();
      const uid = el.dataset.follow;
      const on = el.classList.contains("on");
      try {
        await write("moment.v1.FollowService/ModifyFollow", {
          userId: uid, action: on ? E.UNFOLLOW : E.FOLLOW,
        });
        el.classList.toggle("on", !on);
        el.textContent = !on ? "已关注" : "关注";
        toast(!on ? "已关注" : "已取关");
      } catch (err) { toast("操作失败：" + err.message); }
    };
  });

  // 话题标签
  $$("#view .tag").forEach(el => {
    if (el.tagName === "A") return;
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = (e) => {
      e.stopPropagation();
      const t = el.dataset.tag;
      if (t) location.hash = "#/hashtag/" + encodeURIComponent(t);
    };
  });
  $$("#view .h-row").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = () => {
      const id = el.dataset.hid || el.dataset.hname;
      if (id) location.hash = "#/hashtag/" + encodeURIComponent(id);
    };
  });

  // 通知点击 → 跳详情
  $$("#view .n-row").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = (e) => {
      if (isRawHit(e)) return;
      const mid = el.dataset.mid, uid = el.dataset.uid;
      if (mid) location.hash = "#/moment/" + encodeURIComponent(mid);
      else if (uid) location.hash = "#/user/" + encodeURIComponent(uid);
    };
  });

  // 官方快捷评论：点一下填进输入框
  $$("#view .preset").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = () => {
      const inp = $("#cmtInput");
      if (!inp) return;
      inp.value = el.dataset.preset || "";
      inp.focus();
    };
  });

  // 空内容卡片："重新拉取"
  $$("#view .c-empty-retry").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = async (e) => {
      e.stopPropagation();
      const id = el.dataset.reload;
      if (!id) return;
      el.textContent = "拉取中…";
      try {
        const d = await read("moment.v1.FeedService/GetFeed",
          { feedType: E.FEED_TYPE_MOMENT, feedId: id });
        const m = (d.feed || {}).moment || d.moment;
        if (m) {
          const np = parseMoment({ moment: m });
          if (np.id) {
            S.cache[np.id] = np;
            toast("已拉取到完整内容");
            location.hash = "#/moment/" + encodeURIComponent(id);
            return;
          }
        }
        el.textContent = "服务端仍无内容";
      } catch (err) {
        el.textContent = "拉取失败";
      }
    };
  });

  // 卡片 → 详情（点空白区）
  $$("#view .card").forEach(el => {
    if (el.dataset.bound) return;
    el.dataset.bound = "1";
    el.onclick = (e) => {
      if (isRawHit(e)) return;
      if (el.dataset.id) location.hash = "#/moment/" + encodeURIComponent(el.dataset.id);
    };
  });
}

/** 简易弹出菜单 */
function openMenu(items, ev) {
  const old = document.getElementById("kmenu");
  if (old) old.remove();
  const m = document.createElement("div");
  m.id = "kmenu";
  m.className = "kmenu";
  m.innerHTML = items.map((it, i) => `<div class="kmenu-i" data-i="${i}">${esc(it.t)}</div>`).join("");
  document.body.appendChild(m);
  const x = Math.min(ev.clientX, window.innerWidth - 160);
  m.style.left = x + "px";
  m.style.top = ev.clientY + "px";
  m.querySelectorAll(".kmenu-i").forEach(el => {
    el.onclick = () => { m.remove(); items[+el.dataset.i].fn(); };
  });
  setTimeout(() => {
    document.addEventListener("click", function h() { m.remove(); document.removeEventListener("click", h); });
  }, 0);
}

/** 图片放大查看：支持左右翻页、Esc/点背景关闭 */
function openLightbox(srcs, idx) {
  const old = document.getElementById("klb");
  if (old) old.remove();
  let cur = Math.max(0, idx || 0);
  const box = document.createElement("div");
  box.id = "klb";
  box.className = "klb";
  box.innerHTML = `
    <button class="klb-x" id="klbX">${ICON.close}</button>
    ${srcs.length > 1 ? `<button class="klb-nav klb-prev" id="klbPrev">${ICON.prev}</button>
      <button class="klb-nav klb-next" id="klbNext">${ICON.next}</button>
      <div class="klb-count" id="klbCount"></div>` : ""}
    <img class="klb-img" id="klbImg" src="${esc(srcs[cur])}" referrerpolicy="no-referrer">`;
  document.body.appendChild(box);

  const img = box.querySelector("#klbImg");
  const cnt = box.querySelector("#klbCount");
  const show = () => {
    img.src = srcs[cur];
    if (cnt) cnt.textContent = `${cur + 1} / ${srcs.length}`;
  };
  show();

  const close = () => {
    box.remove();
    document.removeEventListener("keydown", onKey);
  };
  box.querySelector("#klbX").onclick = close;
  box.onclick = (e) => { if (e.target === box) close(); };
  if (srcs.length > 1) {
    box.querySelector("#klbPrev").onclick = (e) => {
      e.stopPropagation(); cur = (cur - 1 + srcs.length) % srcs.length; show();
    };
    box.querySelector("#klbNext").onclick = (e) => {
      e.stopPropagation(); cur = (cur + 1) % srcs.length; show();
    };
  }
  function onKey(e) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft" && srcs.length > 1) {
      cur = (cur - 1 + srcs.length) % srcs.length; show();
    } else if (e.key === "ArrowRight" && srcs.length > 1) {
      cur = (cur + 1) % srcs.length; show();
    }
  }
  document.addEventListener("keydown", onKey);
}

// ══════════════════════════════════════════
//  视图：本地屏蔽名单
// ══════════════════════════════════════════
async function refreshBlock() {
  const j = await (await fetch("/api/block")).json();
  S.block = j.items || [];
}

// 待发布的图片（每项：{fileId, width, height, preview, status}）
let composeImgs = [];

// 读图片真实宽高（给 CreateFile 的 extra 用）
function imageSize(url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({ width: im.naturalWidth || 0, height: im.naturalHeight || 0 });
    im.onerror = () => resolve({ width: 0, height: 0 });
    im.src = url;
  });
}

// 渲染已选图片（本地预览 + 上传状态）
function renderComposeImgs() {
  const box = $("#cvImgs");
  if (!box) return;
  const MAXN = 9;
  box.innerHTML = composeImgs.map((x, i) => `
    <div class="cv-img${x.status === "fail" ? " bad" : ""}">
      <img src="${esc(x.preview)}" alt="">
      ${x.status === "up" ? '<div class="cv-img-mask">上传中…</div>' : ""}
      ${x.status === "ok" ? '<div class="cv-img-ok"><i class="fa-solid fa-check"></i></div>' : ""}
      ${x.status === "fail" ? '<div class="cv-img-mask bad">失败</div>' : ""}
      <span class="cv-img-x" data-i="${i}">${ICON.close}</span>
    </div>`).join("")
    + (composeImgs.length < MAXN
      ? `<div class="cv-img add" id="cvAddMore">${ICON.plus}<span>${composeImgs.length}/9</span></div>` : "");

  $$("#cvImgs .cv-img-x").forEach(el => {
    if (el.dataset.b) return; el.dataset.b = "1";
    el.onclick = () => {
      composeImgs.splice(Number(el.dataset.i), 1);
      renderComposeImgs();
    };
  });
  const add = $("#cvAddMore");
  if (add) add.onclick = () => $("#cvFile").click();
}

// 选图 → 逐张上传
async function handleComposeFiles(files) {
  const tip = $("#cvUpTip");
  const MAXN = 9;
  const list = Array.from(files || []).filter(f => f && f.type && f.type.indexOf("image/") === 0);
  if (!list.length) return;

  const room = MAXN - composeImgs.length;
  if (room <= 0) { toast("最多 9 张"); return; }
  const use = list.slice(0, room);
  if (list.length > room) toast(`最多 9 张，只取前 ${room} 张`);

  for (const f of use) {
    if (f.size > 10 * 1024 * 1024) { toast(`${f.name} 超过 10MB，跳过`); continue; }
    const preview = URL.createObjectURL(f);
    const item = { fileId: "", width: 0, height: 0, preview, status: "up", name: f.name };
    composeImgs.push(item);
    renderComposeImgs();

    try {
      const sz = await imageSize(preview);
      item.width = sz.width; item.height = sz.height;
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(new Error("读取失败"));
        fr.readAsDataURL(f);
      });
      const r = await api("/api/upload", {
        name: f.name, data: dataUrl, width: sz.width, height: sz.height,
      });
      if (!r || !r.ok) throw new Error((r && r.msg) || "上传失败");
      item.fileId = r.fileId || "";
      item.status = "ok";
    } catch (e) {
      item.status = "fail";
      if (tip) tip.textContent = "「" + f.name + "」上传失败：" + e.message;
    }
    renderComposeImgs();
  }

  const okN = composeImgs.filter(x => x.status === "ok").length;
  const failN = composeImgs.filter(x => x.status === "fail").length;
  if (tip && !failN) tip.textContent = okN ? `${okN} 张图片已就绪` : "";
}

// ══════════════════════════════════════════
//  视图：发动态
// ══════════════════════════════════════════
async function viewCompose() {
  composeImgs = [];
  $("#view").innerHTML = `
    <div class="compose-view">
      <div class="sec-hd">发一条动态</div>
      <div class="cv-field">
        <span class="cv-label">标题（可留空）</span>
        <input class="cv-input" id="cvTitle" placeholder="给这条动态起个标题" maxlength="60">
      </div>
      <div class="cv-field">
        <span class="cv-label">正文</span>
        <textarea class="cv-text" id="cvText" placeholder="说点什么…"></textarea>
        <div class="cv-count" id="cvCount">0 / 2000</div>
      </div>
      <div class="cv-field">
        <span class="cv-label">图片（可选，最多 9 张）</span>
        <div class="cv-imgs" id="cvImgs"></div>
        <div class="cv-pick">
          <label class="cv-pick-btn" for="cvFile">${ICON.plus} 选择图片</label>
          <input type="file" id="cvFile" accept="image/*" multiple hidden>
          <span class="cv-pick-tip" id="cvUpTip"></span>
        </div>
      </div>
      <div class="cv-field">
        <span class="cv-label">谁可以看</span>
        <div class="cv-vis">
          <label class="on">
            <input type="radio" name="vis" value="public" checked> 公开
          </label>
          <label>
            <input type="radio" name="vis" value="self"> 仅自己可见
          </label>
        </div>
      </div>
      <div class="cv-acts">
        <button class="btn cv-ok" id="cvSend">发布</button>
        <button class="btn gray" id="cvCancel">取消</button>
      </div>
      <div class="cv-preview" id="cvTip"></div>
    </div>`;

  const title = $("#cvTitle"), text = $("#cvText"), cnt = $("#cvCount"), tip = $("#cvTip");
  const MAX = 2000;

  const fileInp = $("#cvFile");
  if (fileInp) {
    fileInp.onchange = async () => {
      await handleComposeFiles(fileInp.files);
      fileInp.value = "";
    };
  }
  renderComposeImgs();

  text.oninput = () => {
    const n = text.value.length;
    cnt.textContent = n + " / " + MAX;
    cnt.classList.toggle("over", n > MAX);
  };

  $$(".cv-vis label").forEach(lb => {
    const inp = lb.querySelector("input");
    if (!inp) return;
    inp.onchange = () => {
      $$(".cv-vis label").forEach(x => x.classList.remove("on"));
      lb.classList.add("on");
    };
  });

  $("#cvCancel").onclick = () => {
    if ((text.value || "").trim() || (title.value || "").trim()) {
      if (!confirm("放弃这条没发出去的内容？")) return;
    }
    history.back();
  };

  $("#cvSend").onclick = async () => {
    const t = (title.value || "").trim(), v = (text.value || "").trim();
    if (!v) { toast("正文不能为空"); text.focus(); return; }
    if (v.length > MAX) { toast("正文最多 " + MAX + " 字"); return; }
    const visEl = document.querySelector('.cv-vis input[name="vis"]:checked');
    const vis = (visEl && visEl.value === "self") ? E.VIS_SELF : E.VIS_PUBLIC;

    if (composeImgs.some(x => x.status === "up")) {
      toast("还有图片在上传，稍等一下");
      return;
    }
    const btn = $("#cvSend");
    btn.disabled = true; btn.textContent = "发布中…";
    tip.textContent = "";
    try {
      const body = { title: t, text: v, visibility: vis };
      if (composeImgs.length) {
        body.images = composeImgs.map(x => ({
          fileId: x.fileId,
          extra: { width: x.width || 0, height: x.height || 0 },
        }));
      }
      const d = await write("moment.v1.MomentService/CreateMoment", body);
      const m = d && (d.moment || d);
      const mid = m && (m.id || "");
      if (!mid) {
        tip.textContent = "发布成功，但没拿到动态 ID，去推荐流刷新看看";
        btn.disabled = false; btn.textContent = "发布";
        return;
      }
      if (vis === E.VIS_PUBLIC) {
        const p = parseMoment({ moment: m });
        if (p.id) S.cache[p.id] = p;
      }
      composeImgs = [];
      toast("已发布");
      location.hash = "#/moment/" + encodeURIComponent(mid);
    } catch (e) {
      btn.disabled = false; btn.textContent = "发布";
      tip.textContent = "发布失败：" + e.message;
    }
  };
}

async function viewBlock() {
  await refreshBlock();
  if (!(S.route && S.route.view === "block")) return;
  const box = $("#view");
  if (!S.block.length) {
    box.innerHTML = `<div class="empty">还没有屏蔽任何人<br>
      <span style="font-size:12.5px">进到对方主页，点「拉黑」即可</span></div>`;
    return;
  }
  box.innerHTML = `<div class="sec-hd">本地屏蔽名单（${S.block.length}）</div>
    <div class="bl-tip">点 × 解除本地屏蔽。若当初是"不感兴趣"或"拉黑"，
      会同时向服务端撤销（UnMute / UnBlock）。</div>` +
    S.block.map(x => {
      const k = x.userId || "name:" + (x.name || "");
      return `<div class="bl-row">
        ${avatarHtml(x.name || "?", "", "sm")}
        <div class="bl-main">
          <div class="bl-n">${esc(x.name || "(没拿到昵称)")}</div>
          <div class="bl-s">${x.userId ? "ID " + esc(x.userId) : "按昵称匹配"}</div>
        </div>
        <button class="bl-x" data-k="${esc(k)}"
          data-uid="${esc(x.userId || "")}" data-obj="${esc(x.objectId || "")}">${ICON.close}</button>
      </div>`;
    }).join("");
  $$("#view .bl-x").forEach(b => {
    b.onclick = async () => {
      if (b.dataset.obj) {
        try {
          await write("moment.v1.MuteService/UnMute",
            { objectType: E.MUTE_MOMENT, objectId: b.dataset.obj });
        } catch (e) { /* 服务端失败也继续解除本地 */ }
      }
      if (b.dataset.uid) {
        try {
          await write("moment.v1.FollowService/ModifyBlock",
            { userId: b.dataset.uid, action: E.UNBLOCK });
        } catch (e) { /* 忽略 */ }
      }
      await api("/api/block/del", { key: b.dataset.k });
      viewBlock();
      toast("已解除");
    };
  });
}

// ══════════════════════════════════════════
//  视图：账号设置（昵称/头像/配额/订阅/设备）
// ══════════════════════════════════════════
async function viewSettings() {
  $("#view").innerHTML = skel(3);
  const blocks = [];
  const safe = async (label, fn) => {
    try { blocks.push({ label, data: await fn() }); }
    catch (e) { blocks.push({ label, err: e.message }); }
  };

  await safe("当前用户", () =>
    read("kimi.gateway.account.v1.UserService/GetCurrentUser", {}));
  await safe("存储空间", () =>
    read("kimi.gateway.storage.v1.StorageService/GetUserStorageQuota", {}));
  await safe("订阅状态", () =>
    read("kimi.gateway.membership.v2.MembershipService/GetSubscription", {}));
  await safe("用户设置", () =>
    read("kimi.usersetting.v1.UserSettingService/GetUserSetting", {}));
  await safe("登录设备", () =>
    read("kimi.gateway.device.v1.DeviceService/ListDevices", {}));

  $("#view").innerHTML = `<div class="sec-hd">账号信息（只读）</div>` +
    blocks.map(b => b.err
      ? `<div class="card">
           <div class="c-title">${esc(b.label)}</div>
           <div class="err" style="margin:0">拿不到：${esc(b.err)}</div>
         </div>`
      : `<div class="card">
           <div class="c-title">${esc(b.label)}</div>
           <span class="raw-toggle">${ICON.caretR} 查看数据</span>
           <pre class="raw" style="display:none">${esc(JSON.stringify(b.data, null, 2))}</pre>
         </div>`).join("") +
    `<div class="bl-tip" style="margin-top:12px">
       高危操作（改绑手机、注销账号、删设备、退订）已被本地服务禁止，
       这里只做只读展示。
     </div>`;
  bindRawToggle();
}

// ══════════════════════════════════════════
//  路由
// ══════════════════════════════════════════
function parseHash() {
  const h = (location.hash || "#/feed").replace(/^#/, "");
  if (h === "" || h === "/" || h === "/feed") return { view: "feed", key: "feed" };
  if (h === "/mine") return { view: "mine", key: "mine" };
  if (h === "/search") return { view: "search", key: "search", q: "" };
  if (h === "/notify") return { view: "notify", key: "notify" };
  if (h === "/me") return { view: "me", key: "me" };
  if (h === "/compose") return { view: "compose", key: "compose" };
  if (h === "/block") return { view: "block", key: "block" };
  if (h === "/settings") return { view: "settings", key: "settings" };
  let m = h.match(/^\/search\/(.+)$/);
  if (m) return { view: "search", key: "search", q: decodeURIComponent(m[1]) };
  m = h.match(/^\/moment\/(.+)$/);
  if (m) return { view: "moment", key: "moment_" + m[1], id: decodeURIComponent(m[1]) };
  m = h.match(/^\/user\/(.+)$/);
  if (m) return { view: "user", key: "user_" + m[1], id: decodeURIComponent(m[1]) };
  m = h.match(/^\/follows\/(.+)$/);
  if (m) return { view: "follows", key: "follows_" + m[1], id: decodeURIComponent(m[1]) };
  m = h.match(/^\/hashtag\/(.+)$/);
  if (m) return { view: "hashtag", key: "hashtag_" + m[1], id: decodeURIComponent(m[1]) };
  return { view: "feed", key: "feed" };
}

function syncTab(view) {
  const map = {
    moment: "feed", user: "feed", follows: "feed", hashtag: "feed",
  };
  const v = map[view] || view;
  $$(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === v));
}

async function router() {
  const r = parseHash();
  const prev = S.route;
  S.route = r;

  // 换页就清掉上一页的原始 JSON 缓存，避免长期累积
  if (!prev || prev.key !== r.key) {
    for (const k in RAW_STORE) delete RAW_STORE[k];
  }

  if (prev && prev.key !== r.key) {
    // 个人主页的滚动位置记在 uMoments_<uid> 上（路由 key 是 user_<id>）
    const pk = (prev.view === "user") ? "uMoments_" + prev.id : prev.key;
    if (S.lists[pk]) S.lists[pk].scroll = window.scrollY;
  }

  syncTab(r.view);

  const restore = () => {
    const st = S.lists[r.key];
    if (st && st.scroll) requestAnimationFrame(() => window.scrollTo(0, st.scroll));
    else window.scrollTo(0, 0);
  };

  try {
    if (r.view === "feed" || r.view === "mine") {
      const st = listState(r.key);
      if (st.loaded && st.items.length) {
        renderItems(st.items, cardHtml, "没有内容");
        restore();
      } else await viewFeed(r.view);
      return;
    }
    if (r.view === "search") { await viewSearch(); return; }
    if (r.view === "notify") {
      const st = listState("notify");
      if (st.loaded && st.items.length) { renderItems(st.items, notifHtml, "还没有通知"); restore(); }
      else await viewNotify();
      return;
    }
    if (r.view === "me") {
      const me = S.me || (S.me = await read("moment.v1.UserService/GetMe", { view: E.VIEW_FULL }));
      const uid = myIdFrom(me);
      if (uid) { location.replace("#/user/" + encodeURIComponent(uid)); return; }
      $("#view").innerHTML = `<div class="err">取不到自己的 userId
        <pre class="raw" style="display:block;max-height:240px">${
          esc(JSON.stringify(me, null, 2))}</pre></div>`;
      return;
    }
    if (r.view === "compose") { await viewCompose(); window.scrollTo(0, 0); return; }
    if (r.view === "block") { await viewBlock(); window.scrollTo(0, 0); return; }
    if (r.view === "settings") { await viewSettings(); window.scrollTo(0, 0); return; }
    if (r.view === "moment") { await viewMoment(r.id); window.scrollTo(0, 0); return; }
    if (r.view === "user") {
      // 已完整渲染过同一人的主页 → 直接还原 DOM + 滚动位置，不重复请求
      // （重复请求会触发新一轮分页，既慢又容易错位）
      const pg = S.userPage;
      if (pg && pg.id === r.id && pg.html) {
        $("#view").innerHTML = pg.html;
        bindDynamic(); bindRawToggle();
        const st = S.lists["uMoments_" + r.id];
        if (st && st.scroll) requestAnimationFrame(() => window.scrollTo(0, st.scroll));
        else window.scrollTo(0, 0);
        return;
      }
      await viewUser(r.id); window.scrollTo(0, 0); return;
    }
    if (r.view === "follows") { await viewFollows(r.id); window.scrollTo(0, 0); return; }
    if (r.view === "hashtag") { await viewHashtag(r.id); window.scrollTo(0, 0); return; }
  } catch (e) {
    $("#view").innerHTML = `<div class="err">页面出错：${esc(e.message)}</div>`;
  }
}

// 滚动到底续加载
window.addEventListener("scroll", () => {
  if (!S.route) return;
  const r = S.route;
  const V = r.view;
  if (V !== "feed" && V !== "mine" && V !== "notify"
      && V !== "search" && V !== "user") return;

  let key = r.key;
  if (V === "search") key = searchKey((S.route && S.route.q) || "");
  else if (V === "user") key = "uMoments_" + r.id;

  const st = S.lists[key];
  if (!st || st.loading || !st.token) return;
  if (window.innerHeight + window.scrollY < document.body.offsetHeight - 400) return;

  if (V === "notify") viewNotifyAppend();
  else if (V === "search") searchAppend((S.route && S.route.q) || "");
  else if (V === "user") viewUserAppend(r.id);
  else viewFeedAppend(V);
});

// 搜索结果滚动续加载
async function searchAppend(q) {
  if (!q) return;
  const key = searchKey(q);
  await loadPage(key, async (token) => {
    const body = { query: q, pageSize: 20 };
    if (token) body[PT] = token;
    if (searchTab === "user") {
      const d = await read("moment.v1.SearchService/SearchUsers", body);
      return { items: pickList(d, "moment.v1.SearchService/SearchUsers")
        .map(unwrap).map(parseUser), token: d[NPT] || "" };
    }
    if (searchTab === "hashtag") {
      const d = await read("moment.v1.SearchService/SearchHashtags", body);
      return { items: pickList(d, "moment.v1.SearchService/SearchHashtags")
        .map(unwrap).map(parseHashtag), token: d[NPT] || "" };
    }
    const d = await read("moment.v1.SearchService/SearchMoments", body);
    const items = pickList(d, "moment.v1.SearchService/SearchMoments")
      .map(unwrap).map(parseMoment);
    items.forEach(x => { if (x.id) S.cache[x.id] = x; });
    return { items, token: d[NPT] || "" };
  }, searchRenderer(), { append: true, container: "#resultBox" });
}

// 通知滚动续加载（idLt 游标）
async function viewNotifyAppend() {
  const st = S.lists.notify;
  const cursor = st && st.token;
  if (!cursor) return;
  await loadPage("notify", async () => {
    const d = await read("moment.v1.NotificationService/ListNotification",
      { limit: 30, idLt: cursor });
    const idx = buildNotifIndex(d);
    const items = (d.notifications || []).map(n => parseNotification(n, idx));
    const last = items.length ? items[items.length - 1].id : "";
    return { items, token: (items.length >= 30 && last) ? last : "" };
  }, notifHtml, { append: true });
  fillNotifNames();
}

async function viewFeedAppend(kind) {
  const key = kind === "mine" ? "mine" : "feed";
  const category = kind === "mine" ? E.FEED_FOLLOW : E.FEED_RECOMMEND;
  let uid = "";
  if (kind === "mine") uid = myId();
  await loadPage(key, async (token) => {
    const body = { pageSize: 20, category };
    if (kind === "mine" && uid) body.userId = uid;
    if (token) body[PT] = token;
    const d = await read("moment.v1.FeedService/ListFeeds", body);
    const items = pickList(d, "moment.v1.FeedService/ListFeeds")
      .map(f => (f && f.moment) || f)
      .map(parseMoment).filter(x => x.id || x.title || x.excerpt);
    items.forEach(x => { if (x.id) S.cache[x.id] = x; });
    return { items, token: d[NPT] || "" };
  }, cardHtml, { append: true });
}

$("#btnRefresh").onclick = async () => {
  const r = S.route;
  if (!r) return;
  // 列表 key 未必等于路由 key（个人主页是 uMoments_<id>，搜索是 search_<tab>_<q>）
  const keys = [r.key];
  if (r.view === "user") keys.push("uMoments_" + r.id);
  if (r.view === "search") keys.push(searchKey(r.q || ""));
  for (const k of keys) {
    if (S.lists[k]) { S.lists[k].token = ""; S.lists[k].loaded = false; S.lists[k].scroll = 0; }
  }
  // 个人主页缓存也作废，强制重拉
  if (r.view === "user") S.userPage = null;
  await router();
  toast("已刷新");
};

// ══════════════════════════════════════════
//  启动
// ══════════════════════════════════════════
async function checkGate() {
  const s = await (await fetch("/api/status")).json();
  const el = $("#status");
  if (s.logged) {
    el.textContent = "已登录 · " + Math.floor(s.expireIn / 60) + "分钟";
    el.className = "ok";
    $("#gate").classList.add("hidden");
    return true;
  }
  el.textContent = "未登录";
  el.className = "bad";
  $("#gate").classList.remove("hidden");
  $("#gateStep").innerHTML = `
    <ol>
      <li>在浏览器打开 <code>kimi.com</code> 正常登录</li>
      <li>油猴脚本会自动把凭证送到本地服务</li>
      <li>回来点下面的按钮</li>
    </ol>
    <div class="warn">凭证只保存在你本机的 <code>token.json</code>，不会上传。</div>
    <button class="btn" onclick="location.reload()">我登录好了，刷新</button>`;
  return false;
}

(async function init() {
  // 主题优先初始化，未登录也能切换
  initTheme();

  window.addEventListener("hashchange", router);
  if (!(await checkGate())) return;
  try { S.me = await read("moment.v1.UserService/GetMe", { view: E.VIEW_FULL }); } catch (e) { /* 忽略 */ }
  await refreshBlock();
  await router();
})();