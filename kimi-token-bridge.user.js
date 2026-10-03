// ==UserScript==
// @name         Kimi 凭证桥接
// @namespace    kimi-web-discover
// @version      1.0
// @description  在 kimi.com 登录后，把登录凭证送到你本机的发现页服务。只发到 127.0.0.1，不外传。
// @author       Minecraft_goose
// @match        https://www.kimi.com/*
// @match        https://kimi.moonshot.cn/*
// @match        https://auth.kimi.com/*
// @connect      127.0.0.1
// @connect      localhost
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const ENDPOINT = 'http://127.0.0.1:8787/api/token';
    const DEBUG = true;

    let sent = false;      // 已成功送达就不再重复发
    let lastPair = '';     // 避免重复发同样的内容

    const log = (...a) => { if (DEBUG) console.log('[🔑凭证桥接]', ...a); };

    // ══════════ 找出凭证 ══════════

    /** JWT 长什么样：三段，中间是 base64 */
    function isJwt(s) {
        return typeof s === 'string' && s.split('.').length === 3 && s.length > 60;
    }

    /** 从对象里递归找 accessToken / refreshToken */
    function dig(obj, out, depth) {
        if (!obj || depth > 5 || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length && i < 30; i++) dig(obj[i], out, depth + 1);
            return;
        }
        let n = 0;
        for (const k of Object.keys(obj)) {
            if (n++ > 60) break;
            const v = obj[k];
            if (v === null || v === undefined) continue;
            if (typeof v === 'string') {
                const lk = k.toLowerCase();
                if (isJwt(v)) {
                    if (/refresh/i.test(lk) || /refresh/i.test(k)) out.refresh = v;
                    else if (/access/i.test(lk) || /access/i.test(k)) out.access = v;
                    else if (!out.other) out.other = v;   // 字段名不含 access，先存着
                }
            } else if (typeof v === 'object') {
                dig(v, out, depth + 1);
            }
        }
    }

    /** 翻 localStorage / sessionStorage */
    function scanStorage() {
        const out = {};
        for (const S of [window.localStorage, window.sessionStorage]) {
            if (!S) continue;
            try {
                for (let i = 0; i < S.length; i++) {
                    const k = S.key(i);
                    if (!k) continue;
                    const raw = S.getItem(k);
                    if (!raw) continue;
                    // 值本身就是 JWT
                    if (isJwt(raw)) {
                        if (/refresh/i.test(k)) out.refresh = out.refresh || raw;
                        else out.access = out.access || raw;
                        continue;
                    }
                    // 值是 JSON，里面可能有 token
                    if (raw.length > 2 && (raw[0] === '{' || raw[0] === '[')) {
                        try { dig(JSON.parse(raw), out, 0); } catch (e) { /* 不是JSON */ }
                    }
                }
            } catch (e) { /* 存储不可读 */ }
        }
        return out;
    }

    /** 从 Authorization 头里抓 */
    function fromHeader(h) {
        if (!h) return null;
        const m = String(h).match(/^Bearer\s+(.+)$/i);
        return m && isJwt(m[1]) ? m[1] : null;
    }

    // ══════════ 拦截网络请求（最可靠的一条路）══════════
    const found = { access: '', refresh: '', other: '' };

    function offer(access, refresh) {
        if (access && !found.access) found.access = access;
        if (refresh && !found.refresh) found.refresh = refresh;
        if (!found.access && !found.refresh) return;
        send();
    }

    // 抓 fetch
    const of = window.fetch;
    window.fetch = function (...args) {
        try {
            const req = args[0];
            let h = null;
            if (req && typeof req === 'object' && req.headers) {
                h = req.headers.get ? req.headers.get('authorization')
                    : (req.headers.authorization || req.headers.Authorization);
            } else if (args[1] && args[1].headers) {
                const hh = args[1].headers;
                h = hh.authorization || hh.Authorization || (hh.get && hh.get('authorization'));
            }
            const t = fromHeader(h);
            if (t) offer(t, null);
        } catch (e) { /* 忽略 */ }
        return of.apply(this, args);
    };

    // 抓 XHR
    const OS = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        try {
            if (/^authorization$/i.test(k)) {
                const t = fromHeader(v);
                if (t) offer(t, null);
            }
        } catch (e) { /* 忽略 */ }
        return OS.apply(this, arguments);
    };

    // 抓 XHR 响应里的 token（登录/刷新接口会返回）
    const OO = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
        try { this._u = String(u || ''); } catch (e) { /* 忽略 */ }
        return OO.apply(this, arguments);
    };
    const OSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
        try {
            if (this._u && /RefreshToken|Login|AuthService/i.test(this._u)) {
                this.addEventListener('load', () => {
                    try {
                        const t = this.responseText || '';
                        if (t && t[0] === '{') {
                            const o = {};
                            dig(JSON.parse(t), o, 0);
                            offer(o.access || o.other, o.refresh);
                        }
                    } catch (e) { /* 忽略 */
                    }
                });
            }
        } catch (e) { /* 忽略 */ }
        return OSend.apply(this, arguments);
    };

    // 抓 fetch 的响应（登录/刷新接口）
    const ofResp = window.fetch;
    window.fetch = function (...args) {
        const url = typeof args[0] === 'string' ? args[0]
            : (args[0] && args[0].url) || '';
        const p = ofResp.apply(this, args);
        if (/RefreshToken|Login|AuthService/i.test(url)) {
            p.then(r => {
                try {
                    r.clone().text().then(t => {
                        if (t && t[0] === '{') {
                            const o = {};
                            dig(JSON.parse(t), o, 0);
                            offer(o.access || o.other, o.refresh);
                        }
                    }).catch(() => { /* 忽略 */ });
                } catch (e) { /* 忽略 */ }
            }).catch(() => { /* 忽略 */ });
        }
        return p;
    };

    // ══════════ 送到本机 ══════════
    function send() {
        const access = found.access || '';
        const refresh = found.refresh || found.other || '';
        if (!access && !refresh) return;
        const pair = access.slice(-24) + '|' + refresh.slice(-24);
        if (pair === lastPair) return;   // 同一个凭证不重复发
        lastPair = pair;

        log('准备送达（access 尾号 ...' + access.slice(-8) + '）');
        GM_xmlhttpRequest({
            method: 'POST',
            url: ENDPOINT,
            headers: { 'content-type': 'application/json' },
            data: JSON.stringify({ accessToken: access, refreshToken: refresh }),
            timeout: 5000,
            onload(r) {
                if (r.status === 200) {
                    sent = true;
                    log('✅ 已送达本地服务');
                    badge('ok', '凭证已送达本地发现页');
                } else {
                    log('服务返回 ' + r.status + '（服务没开？）');
                    badge('warn', '本地服务未响应，先启动 server.py');
                }
            },
            onerror() {
                log('连不上本地服务 —— 先运行 python3 server.py');
                badge('warn', '连不上本地服务，先启动 server.py');
            },
        });
    }

    // ══════════ 页面角标 ══════════
    function badge(kind, text) {
        let b = document.getElementById('kb-badge');
        if (!b) {
            GM_addStyle(`
                #kb-badge{position:fixed;left:12px;bottom:12px;z-index:2147483000;
                    padding:8px 14px;border-radius:20px;font-size:12.5px;
                    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
                    box-shadow:0 3px 12px rgba(0,0,0,.18);cursor:pointer;max-width:70vw}
                #kb-badge.ok{background:#e6fcf5;color:#087f5b}
                #kb-badge.warn{background:#fff7e6;color:#8a6d00}
                #kb-badge.idle{background:#f1f3f5;color:#666}`);
            b = document.createElement('div');
            b.id = 'kb-badge';
            document.documentElement.appendChild(b);
            b.onclick = () => b.remove();
        }
        b.className = kind;
        b.textContent = text;
    }

    // ══════════ 定时扫描存储（兜底）══════════
    function scanAndOffer() {
        const o = scanStorage();
        if (o.access) found.access = found.access || o.access;
        if (o.refresh) found.refresh = found.refresh || o.refresh;
        if (!found.access && o.other) found.other = found.other || o.other;
        send();
    }

    // 页面加载后扫一次，之后每 3 秒扫（登录动作会写入存储）
    setTimeout(scanAndOffer, 1200);
    setInterval(() => { if (!sent) scanAndOffer(); }, 3000);

    // ══════════ 菜单 ══════════
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('🔑 立即重新送达凭证', () => {
            lastPair = '';
            scanAndOffer();
        });
        GM_registerMenuCommand('📋 复制凭证到剪贴板（手动用）', () => {
            const o = { accessToken: found.access, refreshToken: found.refresh || found.other };
            const s = JSON.stringify(o, null, 1);
            if (navigator.clipboard) {
                navigator.clipboard.writeText(s).then(
                    () => badge('ok', '已复制，粘到发现页即可'),
                    () => badge('warn', '复制失败，看控制台'));
            }
            console.log('[🔑凭证]', s);
        });
        GM_registerMenuCommand('⚠️ 清除已抓到的凭证', () => {
            found.access = found.refresh = found.other = '';
            lastPair = '';
            sent = false;
            badge('idle', '已清除');
        });
    }

    log('已就绪 —— 在 kimi.com 登录后会自动送达');
})();
