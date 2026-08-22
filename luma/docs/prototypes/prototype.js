/**
 * Luma 产品原型。
 *
 * 静态页，不接后端，也不打算接。每一屏是一个返回 HTML 字符串的函数，用来看
 * 手指会落在哪里——不用来讨论颜色，更不是要被搬进 src/web。
 *
 * 设计依据在 ../07-product-design.md。屏与屏之间可以点：姿势卡、磁贴、底栏、
 * 侧栏按钮都会跳到对应的那一屏。
 */
(function () {
  "use strict";

  /* --------------------------------------------------------------- icons */

  var PATHS = {
    chat: '<path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4z"/>',
    images:
      '<rect x="3" y="3" width="14" height="12" rx="2"/><circle cx="8" cy="7.5" r="1.2"/><path d="m4.5 13 3.2-3.2L11 13l2-2 4 4"/><path d="M8 21h11a2 2 0 0 0 2-2V8"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.2"/><path d="m20 20-3.6-3.6"/>',
    spark: '<path d="M12 3.5 13.9 9 19.5 11 13.9 13 12 18.5 10.1 13 4.5 11 10.1 9z"/>',
    film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v14M16 5v14M3 12h18"/>',
    clip: '<path d="M19.5 11.5 12 19a4.5 4.5 0 0 1-6.4-6.4l7.7-7.7a3 3 0 1 1 4.2 4.2l-7.6 7.6a1.5 1.5 0 0 1-2.1-2.1l7-7"/>',
    sliders: '<path d="M4 7h5M13 7h7M4 17h9M17 17h3"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    x: '<path d="M6 6 18 18M18 6 6 18"/>',
    play: '<path d="M8 5.4v13.2L19 12z"/>',
    down: '<path d="M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5"/><path d="M5 20h14"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    shield: '<path d="M12 3 20 6v6c0 4.6-3.3 8-8 9-4.7-1-8-4.4-8-9V6z"/>',
    plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
    alert: '<path d="M12 4 2.6 20.5h18.8z"/><path d="M12 10v4.5M12 17.5h.01"/>',
    wrench: '<path d="M15.5 3.5a4.5 4.5 0 0 0-5.7 5.7l-6 6 2.9 2.9 6-6a4.5 4.5 0 0 0 5.7-5.7l-2.9 2.9-2.9-2.9z"/>',
    book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H15a2 2 0 0 1 2 2v15H6a2 2 0 0 1-2-2z"/><path d="M17 6h1.5A1.5 1.5 0 0 1 20 7.5V20"/>',
    right: '<path d="m9.5 5 7 7-7 7"/>',
    down2: '<path d="m5 9.5 7 7 7-7"/>',
    send: '<path d="M12 20V5m0 0-6.2 6.2M12 5l6.2 6.2"/>',
    clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3 2"/>',
    pin: '<path d="M15 3 21 9l-3.2 1.1-3.4 3.4L13.6 18 6 10.4l4.5-.8 3.4-3.4z"/><path d="m6 18 3.5-3.5"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
    theme: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
    back: '<path d="M14.5 5 7.5 12l7 7"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  };

  var FILLED = { play: true, spark: true };

  function icon(name, size) {
    var d = PATHS[name] || "";
    var s = size || 16;
    var paint = FILLED[name]
      ? 'fill="currentColor" stroke="none"'
      : 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
    return (
      '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" ' + paint +
      ' style="flex:none;display:block">' + d + "</svg>"
    );
  }

  /* ----------------------------------------------------------- primitives */

  function tag(text, cls) {
    return '<span class="tag ' + (cls || "") + '">' + text + "</span>";
  }

  function btn(label, o) {
    o = o || {};
    return (
      '<button class="btn ' + (o.cls || "") + '"' + (o.go ? ' data-go="' + o.go + '"' : "") + ">" +
      (o.icon ? icon(o.icon, o.iconSize || 15) : "") + (label ? "<span>" + label + "</span>" : "") +
      "</button>"
    );
  }

  function pill(label, o) {
    o = o || {};
    return (
      '<span class="pill ' + (o.cls || "") + '"' + (o.go ? ' data-go="' + o.go + '"' : "") + ">" +
      (o.icon ? icon(o.icon, 13) : "") + label + "</span>"
    );
  }

  /** A stand-in for a picture. No binary assets in the repo for a prototype. */
  function ph(label, hue, style, go) {
    return (
      '<div class="ph' + (go ? " clickable" : "") + '" style="--h:' + hue + ";" + (style || "") + '"' +
      (go ? ' data-go="' + go + '"' : "") + ">" + (label ? "<span>" + label + "</span>" : "") + "</div>"
    );
  }

  function vid(label, hue, dur, style, go) {
    return (
      '<div class="ph' + (go ? " clickable" : "") + '" style="--h:' + hue + ";" + (style || "") + '"' +
      (go ? ' data-go="' + go + '"' : "") + '><span class="dur">' + dur + "</span>" +
      '<div class="play">' + icon("play", 12) + "</div>" +
      (label ? "<span>" + label + "</span>" : "") + "</div>"
    );
  }

  function switchRow(label, sub, on) {
    return (
      '<div class="rowitem"><div class="grow col tight"><div>' + label + "</div>" +
      (sub ? '<div class="tiny muted">' + sub + "</div>" : "") +
      '</div><div class="switch ' + (on ? "on" : "") + '"><span></span></div></div>'
    );
  }

  /* ------------------------------------------------------------- fixtures */

  var CONVS = [
    { id: "story", posture: "故事", title: "雨夜巷口 · 第三幕", hue: 292, live: true, when: "今天" },
    { id: "create", posture: "创作", title: "便利店霓虹 · 找一版封面", hue: 32, when: "今天" },
    { id: "do", posture: "做事", title: "三份周报合成月报", when: "今天", pending: true },
    { id: "role", posture: "角色", title: "深夜电台 DJ", hue: 340, ephemeral: true, when: "今天" },
    { id: "chat", posture: "对话", title: "128 BPM 的卡点脚本", when: "最近 7 天" },
    { id: "chat", posture: "创作", title: "赛博工装 · 角色三视图", hue: 210, when: "最近 7 天" },
    { id: "chat", posture: "对话", title: "把 NAS 的硬盘阵列理一遍", when: "最近 7 天" },
  ];

  function convList(active) {
    var out = "";
    var group = "";
    CONVS.forEach(function (c, i) {
      if (c.when !== group) {
        group = c.when;
        out += '<div class="railgroup">' + group + "</div>";
      }
      var cover = c.hue
        ? '<div class="cover ph" style="--h:' + c.hue + '"></div>'
        : '<div class="cover blank">' + icon("chat", 14) + "</div>";
      out +=
        '<div class="convrow clickable" data-go="' + c.id + '"' +
        (i === active ? ' aria-current="true"' : "") + ">" + cover +
        '<div class="grow col tight"><div class="row" style="gap:6px">' +
        '<span class="truncate small">' + c.title + "</span>" +
        (c.live ? '<span class="dot"></span>' : "") + "</div>" +
        '<div class="row tiny muted" style="gap:5px">' + c.posture +
        (c.ephemeral ? " · 临时" : "") + (c.pending ? " · 待批 1" : "") +
        (c.live ? " · 生成中" : "") + "</div></div></div>";
    });
    return out;
  }

  var NAV = [
    { label: "会话", glyph: "chat", go: "home", on: ["home", "chat", "do", "create", "inspector", "role", "story", "first"] },
    { label: "作品", glyph: "images", go: "works", on: ["works", "asset", "refs"] },
    { label: "我的", glyph: "user", go: "mine", on: ["mine", "settings", "health"] },
  ];

  function navbar(screen) {
    return (
      '<nav class="navbar">' +
      NAV.map(function (n) {
        var on = n.on.indexOf(screen) >= 0;
        return (
          '<button class="navitem clickable" data-go="' + n.go + '"' + (on ? ' aria-current="true"' : "") +
          '><span class="glyph">' + icon(n.glyph, 17) + "</span>" + n.label + "</button>"
        );
      }).join("") + "</nav>"
    );
  }

  function rail(screen, active) {
    return (
      '<aside class="rail">' +
      '<div class="railhead"><div class="row" style="gap:7px"><span class="mark">' + icon("spark", 12) +
      "</span>Luma</div>" +
      '<div class="row" style="gap:2px"><button class="btn sm">' + icon("theme", 15) + "</button>" +
      '<button class="btn sm">' + icon("more", 15) + "</button></div></div>" +
      '<div class="railpad col tight">' +
      '<button class="btn outline block clickable" style="justify-content:flex-start" data-go="home">' +
      icon("plus", 15) + "新会话</button>" +
      '<div class="field row" style="gap:6px">' + icon("search", 14) + "搜索会话与作品</div></div>" +
      '<div class="raillist">' + convList(active) + "</div>" +
      navbar(screen) + "</aside>"
    );
  }

  function desktop(o) {
    return (
      '<div class="frame desktop">' + (o.rail === false ? "" : rail(o.screen, o.active)) +
      '<div class="main relative">' + (o.topbar || "") +
      '<div class="body"><div class="centercol">' + (o.center || "") + "</div>" +
      (o.aside ? '<div class="aside">' + o.aside + "</div>" : "") + "</div>" +
      (o.overlay || "") + "</div></div>"
    );
  }

  function topbar(left, right) {
    return '<div class="topbar">' + left + '<div class="grow"></div>' + (right || "") + "</div>";
  }

  var PHONE_TABS = [
    { label: "会话", glyph: "chat", go: "p-home", on: ["p-home", "p-new", "p-session", "p-sheet", "p-params"] },
    { label: "作品", glyph: "images", go: "p-works", on: ["p-works"] },
    { label: "我的", glyph: "user", go: "p-mine", on: ["p-mine"] },
  ];

  function phone(o) {
    var tabs = o.tabs === false ? "" :
      '<div class="tabbar">' + PHONE_TABS.map(function (t) {
        var on = t.on.indexOf(o.screen) >= 0;
        return (
          '<button class="tabitem clickable" data-go="' + t.go + '"' + (on ? ' aria-current="true"' : "") +
          '><span class="glyph">' + icon(t.glyph, 19) + "</span>" + t.label + "</button>"
        );
      }).join("") + "</div>";
    return (
      '<div class="frame phone relative">' +
      '<div class="statusbar"><span>9:41</span><span class="row" style="gap:5px">' +
      '<span class="tiny">家里那台</span><span class="dot ok"></span></span></div>' +
      (o.head || "") + '<div class="phonebody">' + (o.body || "") + "</div>" + tabs +
      (o.sheet ? '<div class="scrim"></div><div class="sheet">' + o.sheet + "</div>" : "") + "</div>"
    );
  }

  function phoneHead(left, title, right) {
    return (
      '<div class="phonehead">' + left +
      '<div class="grow col tight" style="gap:0">' + title + "</div>" + (right || "") + "</div>"
    );
  }

  /* -------------------------------------------------------------- pieces */

  function composer(o) {
    o = o || {};
    return (
      '<div class="composerwrap"><div class="composer">' +
      '<div class="ghosttext">' + (o.ghost || "输入消息，Enter 发送") + "</div>" +
      '<div class="actions">' + btn("", { icon: "clip", cls: "sm" }) +
      (o.shortcuts || []).map(function (s) {
        return btn(s.label, { icon: s.icon, cls: "sm outline", go: s.go });
      }).join("") +
      '<div class="grow"></div>' + (o.right || "") +
      btn("", { icon: "send", cls: "sm primary" }) + "</div></div>" +
      (o.foot ? '<div class="footnote">' + o.foot + "</div>" : "") + "</div>"
    );
  }

  function toolBlock(name, arg, state) {
    return (
      '<div class="tool">' + icon("right", 13) +
      '<span class="name">' + name + "</span>" +
      '<span class="arg">' + arg + "</span>" +
      (state === "run"
        ? tag("进行中", "live")
        : state === "wait"
          ? tag("等批准", "warn")
          : tag("完成", "ok")) + "</div>"
    );
  }

  function jobCard(title, sub, pct, o) {
    o = o || {};
    return (
      '<div class="card tight col tight' + (o.go ? " clickable" : "") + '"' +
      (o.go ? ' data-go="' + o.go + '"' : "") + '><div class="row between">' +
      '<span class="small row" style="gap:6px">' + icon(o.icon || "film", 14) + title + "</span>" +
      '<span class="tiny muted">' + sub + "</span></div>" +
      '<div class="bar"><span style="width:' + pct + '%"></span></div></div>'
    );
  }

  function postureCard(title, line, go, glyph) {
    return (
      '<div class="card col tight clickable" data-go="' + go + '" style="gap:6px">' +
      '<div class="row" style="gap:7px">' + icon(glyph, 15) + '<span class="strong">' + title + "</span></div>" +
      '<div class="tiny muted">' + line + "</div></div>"
    );
  }

  /* ------------------------------------------------------------- screens */

  var S = {};

  /* 首页 ---------------------------------------------------------------- */

  S.home = function () {
    return desktop({
      screen: "home",
      active: -1,
      topbar: topbar(
        '<span class="strong">今天</span><span class="muted small">三段会话 · 两件在生成</span>',
        btn("Qwen3-Max", { icon: "down2", cls: "sm outline" })
      ),
      center:
        '<div class="scroll pad col" style="gap:16px">' +
        '<div class="card row clickable" style="gap:14px;align-items:stretch" data-go="story">' +
        ph("", 292, "width:132px;flex:none;aspect-ratio:4/3") +
        '<div class="grow col tight" style="justify-content:center">' +
        '<div class="row" style="gap:7px">' + tag("故事", "posture") +
        '<span class="big">雨夜巷口 · 第三幕</span></div>' +
        '<div class="small muted">「她把伞收起来的时候，灯牌刚好闪了一下。」</div>' +
        '<div class="row tiny muted" style="gap:6px">' + icon("clock", 12) +
        "12 分钟前 · 41 条 · 一段视频在生成</div></div>" +
        '<div class="row" style="align-items:center">' + btn("继续", { cls: "primary", icon: "right" }) + "</div></div>" +

        '<div class="row" style="gap:10px">' +
        '<div class="grow">' + jobCard("Seedance · 图生视频", "约 2 分钟", 62, { go: "works" }) + "</div>" +
        '<div class="grow">' + jobCard("Lustify v10 · 生图", "排队中 1/2", 12, { icon: "images", go: "works" }) + "</div>" +
        "</div>" +

        '<div class="card row" style="gap:10px;border-color:color-mix(in oklab,var(--warning) 45%,transparent);' +
        'background:color-mix(in oklab,var(--warning) 10%,transparent)">' +
        icon("alert", 16) +
        '<div class="grow col tight"><span class="small strong">「三份周报合成月报」在等你批准</span>' +
        '<span class="tiny muted">write_file → data/files/2026-08 月报.md</span></div>' +
        btn("去看看", { cls: "sm outline", go: "do" }) + "</div>" +

        '<div class="col tight"><div class="row between"><span class="small muted">新会话</span>' +
        '<span class="tiny muted">默认就是「对话」，直接说话即可</span></div>' +
        '<div class="grid" style="grid-template-columns:repeat(4,1fr)">' +
        postureCard("做事", "搜、读文件、改东西、记下来", "do", "wrench") +
        postureCard("创作", "边聊边出图、改图、让它动", "create", "images") +
        postureCard("角色", "入戏。可以用完就扔", "role", "user") +
        postureCard("故事", "连续的图文，人物不跑形", "story", "book") +
        "</div></div>" +

        '<div class="tiny muted">上次同步：2 分钟前 · 本机 ComfyUI ' +
        '<span class="dot bad"></span> 没在监听 · <span class="clickable" data-go="health" ' +
        'style="text-decoration:underline">看后端健康</span></div>' +
        "</div>",
    });
  };

  /* 会话 · 对话 --------------------------------------------------------- */

  S.chat = function () {
    return desktop({
      screen: "chat",
      active: 4,
      topbar: topbar(
        tag("对话", "posture") + '<span class="strong">128 BPM 的卡点脚本</span>',
        btn("Qwen3-Max", { icon: "down2", cls: "sm outline" }) +
          btn("", { icon: "sliders", cls: "sm" })
      ),
      center:
        '<div class="transcript"><div class="stream">' +
        '<div class="user">写个五图卡点脚本，128 BPM</div>' +
        toolBlock("set_memory", "记住宋亮偏好的卡点节奏", "done") +
        '<div class="assistant"><p>先定结构。<b>五图卡点</b>：开门入冬 → 清点存货 → 蒸汽里听见脚步。</p>' +
        "<h4>分镜</h4><p>1. 开门：手推门，冷气涌出，0.8 秒定帧。<br>" +
        "2. 清点存货：俯拍货架，快速横移。<br>3. 蒸汽：水壶特写，蒸汽升起时切鼓点。</p>" +
        "<p>顺手画了第三张的参考：</p></div>" +
        '<div class="row" style="gap:8px">' +
        ph("蒸汽 · 水壶特写", 26, "width:210px;aspect-ratio:4/3", "asset") +
        '<div class="col tight" style="justify-content:center">' +
        btn("改这张", { icon: "images", cls: "sm outline", go: "asset" }) +
        btn("让它动", { icon: "film", cls: "sm outline", go: "asset" }) +
        btn("放到参考", { icon: "pin", cls: "sm outline", go: "refs" }) +
        "</div></div>" +
        '<div class="assistant"><p>要我把这一版做成五张吗？还是先把第三张调暖一点。</p></div>' +
        "</div></div>" +
        composer({
          ghost: "输入消息，Enter 发送，Shift+Enter 换行",
          foot: "联网搜索 · 文件检索 · 记忆 · 图像与视频",
        }),
    });
  };

  /* 会话 · 做事 --------------------------------------------------------- */

  S.do = function () {
    return desktop({
      screen: "do",
      active: 2,
      topbar: topbar(
        tag("做事", "posture") + '<span class="strong">三份周报合成月报</span>',
        pill("工具 6", { icon: "wrench" }) + btn("Claude Opus 4.6", { icon: "down2", cls: "sm outline" })
      ),
      center:
        '<div class="transcript"><div class="stream">' +
        '<div class="user">把 8 月这三份周报合成一份月报，写进 files 里，标题按上个月的格式</div>' +
        toolBlock("file_search", "周报 8月 · 命中 3 个文件", "done") +
        toolBlock("read_file", "2026-07 月报.md", "done") +
        '<div class="assistant"><p>三份周报的重点合并后是四条主线，格式沿用 7 月那份。' +
        "写之前要新建一个文件：</p></div>" +
        '<div class="approval col tight">' +
        '<div class="row" style="gap:8px">' + icon("alert", 16) +
        '<span class="small strong">write_file 要新建一个文件</span></div>' +
        '<div class="mono tiny muted">data/files/2026-08 月报.md · 3.4 KB</div>' +
        '<div class="row" style="gap:6px">' + btn("批准", { cls: "sm primary", icon: "check" }) +
        btn("拒绝", { cls: "sm outline", icon: "x" }) + btn("看全文", { cls: "sm" }) + "</div></div>" +
        "</div></div>" +
        composer({
          ghost: "回答还在写。插一句，这轮完了算进去。",
          shortcuts: [{ label: "联网搜", icon: "search" }],
          right: btn("停止", { icon: "stop", cls: "sm outline" }),
        }),
      aside:
        '<div class="asidehead">这一段在用的</div>' +
        '<div class="card tight col tight">' +
        ['周报-08-04.docx', '周报-08-11.docx', '周报-08-18.docx'].map(function (f) {
          return '<div class="row small" style="gap:7px">' + icon("folder", 14) +
            '<span class="grow truncate">' + f + "</span>" + tag("就绪", "ok") + "</div>";
        }).join("") + "</div>" +
        '<div class="asidehead">检索命中</div>' +
        '<div class="card tight col tight small muted">' +
        "<div>2026-07 月报.md · 第 1 段</div><div>周报-08-18.docx · 第 3 段</div></div>" +
        '<div class="asidehead">待批 <span class="tag warn">1</span></div>' +
        '<div class="card tight small">write_file · 新建月报</div>' +
        '<div class="asidehead">工作目录</div>' +
        '<div class="card tight mono tiny muted">D:\\AIGC · 读写开，shell 关</div>',
    });
  };

  /* 会话 · 创作 --------------------------------------------------------- */

  function createCenter() {
    return (
      '<div class="transcript"><div class="stream wide">' +
      '<div class="user">一个雨夜的便利店门口，霓虹，胶片颗粒，人不入镜</div>' +
      toolBlock("generate_image", "rainy convenience store at night, neon…", "done") +
      '<div class="row" style="gap:8px">' +
      ph("v1 · 冷调", 250, "flex:1;aspect-ratio:3/4", "asset") +
      ph("v2 · 暖招牌", 32, "flex:1;aspect-ratio:3/4", "asset") +
      ph("v3 · 广角", 210, "flex:1;aspect-ratio:3/4", "asset") +
      "</div>" +
      '<div class="assistant"><p>三版都带了参考板里的胶片颗粒。第二版的灯牌是英文，' +
      "要换成中文的话我直接改这一张。</p></div>" +
      '<div class="user">第二张，灯牌换成中文，其它别动</div>' +
      toolBlock("edit_image", "源：v2 · 参考：画风 ×1，光 ×1", "done") +
      '<div class="row" style="gap:8px">' +
      ph("v2b · 中文灯牌", 32, "width:240px;aspect-ratio:3/4", "asset") +
      '<div class="col tight" style="justify-content:center">' +
      btn("再来一张", { icon: "images", cls: "sm outline" }) +
      btn("让它动", { icon: "film", cls: "sm outline", go: "asset" }) +
      btn("放到参考", { icon: "pin", cls: "sm outline", go: "refs" }) +
      btn("看血缘", { icon: "right", cls: "sm outline", go: "asset" }) +
      "</div></div>" +
      "</div></div>" +
      composer({
        ghost: "想看见什么？直接说，或者用右边的精确参数。",
        shortcuts: [
          { label: "出图", icon: "images" },
          { label: "改图", icon: "sliders", go: "inspector" },
          { label: "让它动", icon: "film" },
        ],
      })
    );
  }

  function createAside() {
    return (
      '<div class="asidehead">参考板 <span class="tag">钉住 3</span></div>' +
      '<div class="grid tight">' +
      ph("画风", 268, "aspect-ratio:1") + ph("人物 Aya", 340, "aspect-ratio:1") +
      ph("霓虹光", 32, "aspect-ratio:1") +
      '<div class="card tight clickable" data-go="refs" style="display:grid;place-items:center;aspect-ratio:1">' +
      icon("plus", 16) + "</div></div>" +
      '<div class="tiny muted">钉住的参考会自动作为源图和身份锚带进每一次生成，不用每轮重附。</div>' +
      '<div class="asidehead">进行中</div>' +
      jobCard("Seedance · 图生视频", "约 2 分钟", 62) +
      '<div class="asidehead">这一段的作品 <span class="tag">7</span></div>' +
      '<div class="grid tight">' + ph("", 250, "aspect-ratio:1", "asset") + ph("", 32, "aspect-ratio:1", "asset") +
      ph("", 210, "aspect-ratio:1", "asset") + "</div>" +
      '<div class="sep"></div>' +
      btn("精确参数", { icon: "sliders", cls: "outline block", go: "inspector" }) +
      '<div class="tiny muted row" style="gap:6px"><span class="dot bad"></span>' +
      "本机 ComfyUI 没在 8188 上监听，这一栏当前走托管的 Seedream。</div>"
    );
  }

  S.create = function () {
    return desktop({
      screen: "create",
      active: 1,
      topbar: topbar(
        tag("创作", "posture") + '<span class="strong">便利店霓虹 · 找一版封面</span>',
        pill("Seedream 4", { icon: "images" }) + btn("Qwen3-Max", { icon: "down2", cls: "sm outline" })
      ),
      center: createCenter(),
      aside: createAside(),
    });
  };

  S.inspector = function () {
    return desktop({
      screen: "inspector",
      active: 1,
      topbar: topbar(
        tag("创作", "posture") + '<span class="strong">便利店霓虹 · 找一版封面</span>',
        pill("Seedream 4", { icon: "images" }) + btn("Qwen3-Max", { icon: "down2", cls: "sm outline" })
      ),
      center: createCenter(),
      aside: createAside(),
      overlay:
        '<div class="scrim"></div><div class="drawer">' +
        '<div class="topbar"><span class="strong">检查器</span><div class="grow"></div>' +
        '<button class="btn sm clickable" data-go="create">' + icon("x", 15) + "</button></div>" +
        '<div class="scroll pad col" style="gap:12px">' +
        '<div class="segment" style="width:100%">' +
        '<button aria-pressed="true" style="flex:1">生成图片</button>' +
        '<button style="flex:1">编辑图片</button><button style="flex:1">视频</button></div>' +
        '<div class="col tight"><div class="tiny muted">模型</div>' +
        '<div class="field row between">Seedream 4 · 托管' + icon("down2", 14) + "</div>" +
        '<div class="tiny muted">同一份 schema 也在给模型当工具用，只是采样器这类字段不给它看。</div></div>' +
        '<div class="col tight"><div class="tiny muted">提示词</div>' +
        '<div class="field" style="height:96px">rainy convenience store at night, neon sign in Chinese, ' +
        "film grain, 35mm, no people</div></div>" +
        '<div class="col tight"><div class="tiny muted">参考（来自本会话钉住的参考板）</div>' +
        '<div class="row wrap" style="gap:6px">' + pill("画风 · 王家卫夜色", { cls: "on", icon: "check" }) +
        pill("光 · 霓虹反射", { cls: "on", icon: "check" }) + pill("人物 · Aya", { icon: "plus" }) + "</div></div>" +
        '<div class="col tight"><div class="tiny muted">画面比例</div>' +
        '<div class="row wrap" style="gap:6px">' + pill("1:1") + pill("3:4", { cls: "on" }) + pill("16:9") +
        pill("auto") + "</div></div>" +
        '<div class="col tight"><div class="tiny muted">数量</div>' +
        '<div class="row wrap" style="gap:6px">' + pill("1") + pill("2") + pill("3", { cls: "on" }) + "</div></div>" +
        '<div class="card tight row between clickable"><span class="small">高级</span>' +
        '<span class="row tiny muted" style="gap:6px">8 项' + icon("down2", 13) + "</span></div>" +
        btn("开始生成", { cls: "primary block", icon: "spark" }) +
        '<div class="tiny muted">这就是今天创作台那张表单。它现在是抽屉，不是一个栏目。</div>' +
        "</div></div>",
    });
  };

  /* 会话 · 角色 --------------------------------------------------------- */

  S.role = function () {
    return desktop({
      screen: "role",
      active: 3,
      topbar: topbar(
        tag("角色", "posture") + tag("临时", "warn") + '<span class="strong">深夜电台 DJ</span>',
        btn("结束并丢弃", { cls: "sm", icon: "x" }) + btn("保存为卡", { cls: "sm outline", icon: "check" })
      ),
      center:
        '<div class="transcript"><div class="stream">' +
        '<div class="scene">开场</div>' +
        '<div class="assistant"><p><i>凌晨两点十七分，调音台的红灯亮着。他把耳机往下拉了半寸，' +
        "对着麦克风清了清嗓子。</i></p><p>「还醒着的，这一首给你。」</p></div>" +
        '<div class="user">我把车停在路边，听完这首再走</div>' +
        '<div class="assistant"><p><i>他笑了一下，那种在深夜里被人接住的笑。</i></p>' +
        "<p>「路边停车别熄火，冷。」</p></div>" +
        "</div></div>" +
        composer({ ghost: "说点什么…" }),
      aside:
        '<div class="asidehead">角色卡</div>' +
        ph("", 340, "aspect-ratio:1;width:100%") +
        '<div class="col tight"><span class="strong">陈屿</span>' +
        '<span class="tiny muted">深夜电台主持人 · 35 岁</span></div>' +
        '<div class="card tight col tight small">' +
        '<div><span class="muted tiny">外观</span><br>短发微乱，左耳一枚素银耳钉，常年一件灰色针织开衫</div>' +
        '<div><span class="muted tiny">性格</span><br>话少，句子短，不安慰人但会留白</div></div>' +
        '<div class="asidehead">你是谁</div>' +
        '<div class="card tight small">一个刚下夜班、习惯在车里听完一首歌的人</div>' +
        '<div class="asidehead">世界注记 <span class="tag">2</span></div>' +
        '<div class="card tight col tight small muted">' +
        "<div>电台叫「凌晨频道」，只在 1:00–5:00 播</div><div>他从不念听众来信里的名字</div></div>" +
        '<div class="sep"></div>' +
        btn("导入酒馆角色卡", { icon: "down", cls: "outline block" }) +
        '<div class="tiny muted">支持 V2 / V3 的 PNG 卡：外观和开场白直接进这张卡，' +
        "脸同时成为这段会话的身份锚。</div>",
    });
  };

  /* 会话 · 故事 --------------------------------------------------------- */

  S.story = function () {
    return desktop({
      screen: "story",
      active: 0,
      topbar: topbar(
        tag("故事", "posture") + '<span class="strong">雨夜巷口</span>' +
          '<span class="muted small">第三幕 · 41 条</span>',
        pill("人物锁 2", { icon: "pin" }) + btn("Qwen3-Max", { icon: "down2", cls: "sm outline" })
      ),
      center:
        '<div class="transcript"><div class="stream wide">' +
        '<div class="scene">第三幕 · 巷口便利店</div>' +
        '<div class="assistant"><p>Aya 把伞收起来的时候，灯牌刚好闪了一下。' +
        "她没进门，只是站在雨檐下，看着玻璃里自己被切成两半的影子。</p>" +
        "<p>老陈在里面擦柜台，没抬头：「站着也是淋。」</p></div>" +
        toolBlock("generate_image", "画这一幕 · 身份锚：Aya、老陈 · 画风锁 ×1", "done") +
        '<div class="row" style="gap:8px">' +
        ph("第三幕 · 雨檐下", 292, "width:300px;aspect-ratio:16/9", "asset") +
        '<div class="col tight" style="justify-content:center">' +
        btn("让它动", { icon: "film", cls: "sm outline" }) +
        btn("重画这一幕", { icon: "images", cls: "sm outline" }) +
        btn("设为第三幕封面", { icon: "pin", cls: "sm outline" }) + "</div></div>" +
        toolBlock("generate_video", "image_to_video · 5 秒 · 缓慢推近", "run") +
        '<div class="card tight col tight" style="max-width:300px">' +
        '<div class="row between"><span class="small">Seedance · 图生视频</span>' +
        '<span class="tiny muted">约 2 分钟</span></div><div class="bar"><span style="width:62%"></span></div>' +
        '<div class="tiny muted">可以先接着写，好了会通知你。</div></div>' +
        "</div></div>" +
        composer({
          ghost: "接着写，或者让它画这一幕。",
          shortcuts: [
            { label: "续写", icon: "book" },
            { label: "画这一幕", icon: "images" },
            { label: "让这张动", icon: "film" },
          ],
        }),
      aside:
        '<div class="asidehead">连续性 <span class="tiny muted">这段会话的记忆</span></div>' +
        '<div class="card tight col tight">' +
        '<div class="row" style="gap:8px">' + ph("", 340, "width:34px;height:34px;flex:none") +
        '<div class="grow col tight" style="gap:1px"><span class="small strong row" style="gap:5px">Aya' +
        icon("pin", 12) + "</span>" +
        '<span class="tiny muted truncate">银灰短发，左眉一道疤，墨绿风衣</span></div></div>' +
        '<div class="row" style="gap:8px">' + ph("", 60, "width:34px;height:34px;flex:none") +
        '<div class="grow col tight" style="gap:1px"><span class="small strong row" style="gap:5px">老陈' +
        icon("pin", 12) + "</span>" +
        '<span class="tiny muted truncate">六十上下，围裙，右手缺半截小指</span></div></div></div>' +
        '<div class="asidehead">地点</div>' +
        '<div class="card tight small col tight"><div>巷口便利店 · 常年一盏坏了的灯牌</div>' +
        '<div class="tiny muted">雨夜 · 霓虹反射在积水里</div></div>' +
        '<div class="asidehead">画风锁</div>' +
        '<div class="grid tight">' + ph("", 268, "aspect-ratio:1") + ph("", 250, "aspect-ratio:1") + "</div>" +
        '<div class="asidehead">已发生</div>' +
        '<div class="card tight col tight small muted">' +
        "<div>· 第一幕：Aya 收到没有署名的信</div>" +
        "<div>· 第二幕：她在旧仓库认出了那把伞</div>" +
        "<div>· 第三幕：雨夜，她站在便利店门口没进去</div>" +
        '<div class="row top" style="gap:6px;padding-top:4px">' +
        '<span class="grow">· 老陈似乎认识她（模型草拟）</span></div>' +
        '<div class="row" style="gap:6px">' + btn("确认", { cls: "sm outline", icon: "check" }) +
        btn("改一改", { cls: "sm" }) + "</div></div>" +
        '<div class="tiny muted">人物一句话的外貌 + 锁定的参考图，每次出图都会重新注入。' +
        "这就是下一张图里她还是她的原因。</div>",
    });
  };

  /* 作品 ---------------------------------------------------------------- */

  S.works = function () {
    var tiles = [
      ["v2b · 中文灯牌", 32, "3/4"], ["第三幕 · 雨檐下", 292, "16/9"], ["Aya 三视图", 340, "1"],
      ["v1 · 冷调", 250, "3/4"], ["蒸汽 · 水壶", 26, "4/3"], ["巷口 · 广角", 210, "3/4"],
      ["旧仓库", 150, "16/9"], ["伞 · 特写", 300, "1"], ["灯牌 · 局部", 20, "4/3"],
    ];
    return desktop({
      screen: "works",
      active: -1,
      topbar: topbar(
        '<span class="strong">作品</span><span class="muted small">248 件 · 图 213 · 视频 35</span>',
        '<div class="segment"><button aria-pressed="true">全部</button><button>图</button>' +
          '<button>视频</button><button data-go="refs" class="clickable">参考</button>' +
          "<button>角色</button></div>" +
          btn("上传", { icon: "plus", cls: "sm outline" })
      ),
      center:
        '<div class="scroll pad col" style="gap:14px">' +
        '<div class="row" style="gap:10px">' +
        '<div class="grow">' + jobCard("Seedance · 图生视频 · 出自「雨夜巷口」", "约 2 分钟", 62, { go: "story" }) + "</div>" +
        '<div class="grow">' + jobCard("Lustify v10 · 生图 ×2", "排队中", 12, { icon: "images" }) + "</div>" +
        "</div>" +
        '<div class="grid" style="grid-template-columns:repeat(4,1fr)">' +
        vid("雨檐下 · 推近", 292, "5s", "aspect-ratio:16/9;grid-column:span 2", "asset") +
        tiles.slice(0, 6).map(function (t) {
          return ph(t[0], t[1], "aspect-ratio:" + t[2], "asset");
        }).join("") +
        vid("灯牌 · 闪烁", 32, "4s", "aspect-ratio:1", "asset") +
        tiles.slice(6).map(function (t) {
          return ph(t[0], t[1], "aspect-ratio:" + t[2], "asset");
        }).join("") +
        "</div>" +
        '<div class="tiny muted">图和视频同一格网。视频当不了源，所以它的磁贴上没有「以此为源」，' +
        "只有播放、下载和血缘。</div></div>",
    });
  };

  S.asset = function () {
    return desktop({
      screen: "asset",
      active: -1,
      topbar: topbar(
        '<button class="btn sm clickable" data-go="works">' + icon("back", 15) + "返回作品</button>" +
          '<span class="strong">v2b · 中文灯牌</span>',
        btn("", { icon: "down", cls: "sm" }) + btn("", { icon: "more", cls: "sm" })
      ),
      center:
        '<div class="grow" style="display:grid;place-items:center;padding:20px;background:var(--muted)">' +
        ph("v2b · 中文灯牌", 32, "height:100%;aspect-ratio:3/4;max-height:600px") + "</div>" +
        '<div class="row" style="gap:8px;padding:10px 14px;border-top:1px solid var(--border);overflow:auto">' +
        [250, 32, 210, 292, 26, 340, 150, 300].map(function (hu, i) {
          return ph("", hu, "width:58px;height:58px;flex:none" + (i === 1 ? ";outline:2px solid var(--primary)" : ""));
        }).join("") + "</div>",
      aside:
        '<div class="col tight">' +
        btn("改这张", { cls: "primary block", icon: "images" }) +
        btn("让它动", { cls: "outline block", icon: "film" }) +
        btn("放到参考", { cls: "outline block", icon: "pin", go: "refs" }) +
        btn("存到系统相册", { cls: "outline block", icon: "down" }) +
        "</div>" +
        '<div class="asidehead">血缘</div>' +
        '<div class="card tight col tight small">' +
        '<div class="row between"><span class="muted">模型</span><span>Seedream 4</span></div>' +
        '<div class="row between"><span class="muted">提供方</span><span>Ark · 托管</span></div>' +
        '<div class="row between"><span class="muted">操作</span><span>image_to_image</span></div>' +
        '<div class="row between"><span class="muted">画幅</span><span>1024 × 1365</span></div>' +
        '<div class="row between"><span class="muted">时间</span><span>今天 14:22</span></div></div>' +
        '<div class="asidehead">从哪来</div>' +
        '<div class="card tight row" style="gap:8px">' + ph("", 32, "width:44px;height:58px;flex:none", "asset") +
        '<div class="grow col tight"><span class="small">v2 · 暖招牌</span>' +
        '<span class="tiny muted">出自会话「便利店霓虹」</span>' +
        btn("打开那段会话", { cls: "sm outline", go: "create" }) + "</div></div>" +
        '<div class="asidehead">用到的参考</div>' +
        '<div class="row" style="gap:6px">' + pill("画风 · 王家卫夜色") + pill("光 · 霓虹反射") + "</div>" +
        '<div class="asidehead">提示词</div>' +
        '<div class="card tight tiny muted">rainy convenience store at night, neon sign in Chinese, ' +
        "film grain, 35mm, no people</div>" +
        '<div class="row" style="gap:6px">' + btn("复用参数", { cls: "sm outline" }) +
        btn("删除", { cls: "sm danger" }) + "</div>",
    });
  };

  S.refs = function () {
    function board(name, hint, hues) {
      return (
        '<div class="col tight"><div class="row between">' +
        '<span class="strong small">' + name + '</span><span class="tiny muted">' + hint + "</span></div>" +
        '<div class="grid tight" style="grid-template-columns:repeat(8,1fr)">' +
        hues.map(function (hu) { return ph("", hu, "aspect-ratio:1"); }).join("") +
        '<div class="card tight" style="display:grid;place-items:center;aspect-ratio:1">' + icon("plus", 15) +
        "</div></div></div>"
      );
    }
    return desktop({
      screen: "refs",
      active: -1,
      topbar: topbar(
        '<button class="btn sm clickable" data-go="works">' + icon("back", 15) + "返回作品</button>" +
          '<span class="strong">参考板</span>',
        btn("新建集合", { icon: "plus", cls: "sm outline" }) + btn("上传参考", { icon: "plus", cls: "sm primary" })
      ),
      center:
        '<div class="scroll pad col" style="gap:18px">' +
        '<div class="card row" style="gap:12px">' + icon("spark", 18) +
        '<div class="grow col tight"><span class="small strong">参考不是一张匿名的图</span>' +
        '<span class="tiny muted">给它一个用途和一句锚定文本。钉进会话之后，' +
        "生成时会把图作为源、把这句话追加到提示词尾部——这是「下一张里她还是她」的全部机制。</span></div></div>" +
        board("人物", "锚定文本会跟着一起注入", [340, 12, 60]) +
        '<div class="card tight row" style="gap:10px">' + ph("", 340, "width:52px;height:52px;flex:none") +
        '<div class="grow col tight"><span class="small strong">Aya</span>' +
        '<div class="field tiny">银灰短发，左眉一道疤，墨绿风衣，眼下有一颗小痣</div>' +
        '<div class="row tiny muted" style="gap:8px"><span>用在 2 段会话</span><span>·</span>' +
        "<span>出现在 34 张图里</span></div></div>" +
        '<div class="col tight">' + btn("钉到当前会话", { cls: "sm primary", go: "story" }) +
        btn("看用过它的图", { cls: "sm outline", go: "works" }) + "</div></div>" +
        board("画风", "只带图，不带文字锚", [268, 250, 292, 210]) +
        board("场景", "地点的环境参考", [150, 26, 32]) +
        board("光", "光线与色调", [20, 32, 80]) +
        "</div>",
    });
  };

  /* 我的 ---------------------------------------------------------------- */

  S.mine = function () {
    return desktop({
      screen: "mine",
      active: -1,
      topbar: topbar('<span class="strong">我的</span>', btn("设置", { icon: "sliders", cls: "sm outline", go: "settings" })),
      center:
        '<div class="scroll pad col" style="gap:16px">' +
        '<div class="row" style="gap:14px;align-items:stretch">' +
        '<div class="card grow col tight"><div class="row between"><span class="strong">记忆</span>' +
        '<span class="tiny muted">7 条 · 412 / 2000 token</span></div>' +
        '<div class="bar"><span style="width:21%"></span></div>' +
        [
          ["bpm_preference", "喜欢 128 BPM 的卡点节奏"],
          ["photo_taste", "偏胶片颗粒、浅景深、暖光"],
          ["reply_style", "回答不要加免责提醒"],
        ].map(function (m) {
          return '<div class="row small" style="gap:8px"><span class="mono tiny muted" style="width:130px">' +
            m[0] + '</span><span class="grow truncate">' + m[1] + "</span>" +
            '<button class="btn sm">' + icon("more", 14) + "</button></div>";
        }).join("") +
        '<div class="tiny muted">只有你说「记住 / 忘掉」时才写，或者在这里改。不做静默画像。</div></div>' +

        '<div class="card grow col tight"><div class="row between"><span class="strong">文档</span>' +
        '<span class="tiny muted">23 份 · 1.2 GB</span></div>' +
        [
          ["2026-07 月报.md", "就绪", "ok"],
          ["周报-08-18.docx", "就绪", "ok"],
          ["镜头语言笔记.md", "已索引", "warn"],
        ].map(function (f) {
          return '<div class="row small" style="gap:8px">' + icon("folder", 14) +
            '<span class="grow truncate">' + f[0] + "</span>" + tag(f[1], f[2]) + "</div>";
        }).join("") +
        '<div class="tiny muted">没配 embedding 时，块的状态停在「已索引」，关键词检索照常工作。</div>' +
        btn("上传 / 新建笔记", { cls: "outline block", icon: "plus" }) + "</div></div>" +

        '<div class="card col tight"><div class="row between"><span class="strong">连接</span>' +
        tag("在线", "ok") + "</div>" +
        '<div class="row wrap" style="gap:8px">' +
        pill("家里那台 · 192.168.1.20:8090", { icon: "plug" }) +
        pill("队列 2 件", { icon: "clock" }) +
        pill("本机 ComfyUI 没在监听", { icon: "alert", cls: "" }) +
        "</div>" +
        '<div class="row" style="gap:8px">' + btn("后端健康", { cls: "sm outline", go: "health" }) +
        btn("这台设备的会话", { cls: "sm outline", go: "settings" }) + "</div></div>" +

        '<div class="card col tight"><span class="strong">数据</span>' +
        '<div class="small muted">data/ 共 46.8 GB：作品 44.1 GB，文档 1.2 GB，' +
        "对话与索引 1.5 GB。</div>" +
        '<div class="small">没有云端备份。删掉这个目录等于出厂。</div>' +
        '<div class="row" style="gap:8px">' + btn("清掉缩略图缓存", { cls: "sm outline" }) +
        btn("导出这台机器的作品", { cls: "sm outline" }) + "</div></div>" +
        "</div>",
    });
  };

  /* 设置 ---------------------------------------------------------------- */

  function settingsNav(active) {
    var groups = [
      ["连接", [["提供方", "providers"], ["对话模型", "models"], ["后端健康", "health"]]],
      ["生成", [["图与视频后端", "gen"]]],
      ["能力", [["搜索与检索", "cap"], ["编码", "coding"], ["MCP", "mcp"]]],
      ["人格", [["提示词与姿势", "prompts"], ["角色卡", "cards"]]],
      ["系统", [["外观", "look"], ["安全", "sec"], ["数据", "data"]]],
    ];
    return (
      '<div class="settingsnav">' +
      groups.map(function (g) {
        return (
          '<div class="group">' + g[0] + "</div>" +
          g[1].map(function (it) {
            var go = it[1] === "health" ? ' data-go="health" class="item clickable"' : ' class="item clickable"';
            return (
              "<div" + go + (it[1] === active ? ' aria-current="true"' : "") + "><span>" + it[0] + "</span>" +
              (it[1] === "health" ? '<span class="dot bad"></span>' : "") + "</div>"
            );
          }).join("")
        );
      }).join("") + "</div>"
    );
  }

  S.settings = function () {
    return desktop({
      screen: "settings",
      active: -1,
      topbar: topbar('<span class="strong">设置</span><span class="muted small">改完立刻生效，不用重启</span>'),
      center:
        '<div class="body">' + settingsNav("gen") +
        '<div class="scroll pad col" style="gap:16px">' +
        '<div class="col tight"><span class="big">图与视频后端</span>' +
        '<span class="small muted">这三个槽决定对话里的 generate_image / edit_image / ' +
        "generate_video 走哪个模型，也决定检查器默认选中谁。</span></div>" +
        [
          ["默认生图", "Seedream 4 · Ark", "托管 · 密钥已配", "ok"],
          ["默认改图", "Qwen Image Edit 2511 · 本机 ComfyUI", "本地 · 8188 没人听", "bad"],
          ["默认视频", "Seedance 2.5 R2V · Venice", "托管 · 密钥已配", "ok"],
        ].map(function (r) {
          return (
            '<div class="card row" style="gap:12px"><div style="width:88px" class="small muted">' + r[0] + "</div>" +
            '<div class="grow col tight"><div class="field row between">' + r[1] + icon("down2", 14) + "</div>" +
            '<div class="row tiny muted" style="gap:6px"><span class="dot ' + r[3] + '"></span>' + r[2] + "</div></div>" +
            btn("换一个", { cls: "sm outline" }) + "</div>"
          );
        }).join("") +
        '<div class="card col tight">' +
        '<div class="row between"><span class="strong small">生成模型</span>' +
        btn("从提供方拉清单", { cls: "sm outline", icon: "down" }) + "</div>" +
        [
          ["Seedream 4", "image", "Ark", "生成 · 编辑", "ok"],
          ["Lustify v10 Turbo", "image", "本机 ComfyUI", "生成", "bad"],
          ["Boogu Edit Turbo", "image", "本机 ComfyUI", "编辑", "bad"],
          ["Seedance 2.5 R2V", "video", "Venice", "文生视频 · 图生视频", "ok"],
        ].map(function (m) {
          return (
            '<div class="rowitem"><span class="small" style="width:190px">' + m[0] + "</span>" +
            tag(m[1] === "video" ? "视频" : "图片") +
            '<span class="small muted" style="width:130px">' + m[2] + "</span>" +
            '<span class="grow small muted">' + m[3] + "</span>" +
            '<span class="dot ' + m[4] + '"></span></div>'
          );
        }).join("") + "</div>" +
        '<div class="card col tight"><span class="strong small">ComfyUI 工作流</span>' +
        '<div class="small muted">工作流是 data/workflows 里的文件，加一个不是发版。' +
        "绑定和字段映射只在网页改：PATCH 是合并语义，只渲染一半字段的表单一保存就会抹掉另一半，" +
        "所以 iOS 上这块是只读的。</div>" +
        '<div class="row wrap" style="gap:6px">' + pill("lustify-v10-krea-turbo.json") +
        pill("boogu-edit-turbo.json") + pill("qwen-2511-lightning-q4.json") + "</div></div>" +
        "</div></div>",
      rail: true,
    });
  };

  S.health = function () {
    function row(name, sub, state, action) {
      var label = state === "ok" ? "正常" : state === "bad" ? "不可用" : "未配置";
      return (
        '<div class="rowitem"><span class="dot ' + state + '"></span>' +
        '<div class="grow col tight" style="gap:1px"><span class="small">' + name + "</span>" +
        '<span class="tiny muted">' + sub + "</span></div>" + tag(label, state) +
        (action ? btn(action, { cls: "sm outline" }) : "") + "</div>"
      );
    }
    return desktop({
      screen: "health",
      active: -1,
      topbar: topbar('<span class="strong">设置 · 后端健康</span>',
        btn("全部重测", { icon: "clock", cls: "sm outline" })),
      center:
        '<div class="body">' + settingsNav("health") +
        '<div class="scroll pad col" style="gap:16px">' +
        '<div class="card row" style="gap:10px;border-color:color-mix(in oklab,var(--warning) 45%,transparent);' +
        'background:color-mix(in oklab,var(--warning) 10%,transparent)">' + icon("alert", 16) +
        '<div class="grow col tight"><span class="small strong">默认改图绑在本机 ComfyUI 上，而它没在 8188 上监听</span>' +
        '<span class="tiny muted">对话里的 edit_image 现在会失败。Luma 不会悄悄换成别的模型——' +
        "换了你拿到的就不是自己要的画风。</span></div>" +
        btn("换成托管的", { cls: "sm outline", go: "settings" }) + btn("怎么启动", { cls: "sm" }) + "</div>" +
        '<div class="card col tight"><span class="strong small">提供方</span>' +
        row("Ark · ark.cn-beijing.volces.com", "对话 3 · 生图 1 · 延迟 180ms", "ok", "重测") +
        row("Venice · api.venice.ai", "生图 4 · 视频 1 · 延迟 620ms", "ok", "重测") +
        row("本机 ComfyUI · 127.0.0.1:8188", "连接被拒。它只听本机，不跟隧道出去。", "bad", "重测") +
        "</div>" +
        '<div class="card col tight"><span class="strong small">能力</span>' +
        row("联网搜索 · Tavily", "密钥已配 · 支持 read_pages", "ok") +
        row("向量检索 · embedding", "没配。块停在「已索引」，关键词检索照常。", "warn", "去配") +
        row("代码工作目录", "D:\\AIGC · 读写开，shell 关", "ok") +
        row("MCP · 2 台", "playwright（已连）· obsidian（已连）", "ok") +
        "</div>" +
        '<div class="tiny muted">这一页存在的理由：今天这些只在生成失败的那一刻才说话，' +
        "而那时候人已经等过一次了。</div></div></div>",
    });
  };

  S.first = function () {
    return (
      '<div class="frame desktop" style="display:grid;place-items:center;background:var(--muted)">' +
      '<div class="card col" style="width:520px;gap:16px;padding:24px">' +
      '<div class="row" style="gap:8px"><span class="mark">' + icon("spark", 12) + "</span>" +
      '<span class="big">先接一个模型，就能说话了</span></div>' +
      '<div class="steps"><span class="done"></span><span class="done"></span><span></span></div>' +
      '<div class="tiny muted">第 2 步，共 3 步 · 访问码已经验过了</div>' +
      '<div class="col tight"><span class="small strong">加一个提供方</span>' +
      '<div class="field">https://ark.cn-beijing.volces.com/api/v3</div>' +
      '<div class="field">API Key（只提交，之后读不出来）</div>' +
      '<div class="tiny muted">用本机 ComfyUI 出图的话，这一步可以跳过。</div></div>' +
      '<div class="col tight"><span class="small strong">拉到的清单里勾几个</span>' +
      '<div class="card tight col tight">' +
      [
        ["doubao-seed-1.6", "对话 · 256k 窗口", true],
        ["seedream-4-0", "生图 · 也能改图", true],
        ["seedance-2-5-r2v", "视频 · 图生视频", true],
        ["doubao-embedding", "检索用", false],
      ].map(function (m) {
        return (
          '<div class="row small" style="gap:8px"><span class="dot ' + (m[2] ? "ok" : "") + '"></span>' +
          '<span class="grow">' + m[0] + '</span><span class="tiny muted">' + m[1] + "</span></div>"
        );
      }).join("") + "</div>" +
      '<div class="tiny muted">勾上的就是默认：对话、生图、视频三个槽会一次填好。</div></div>' +
      '<div class="row" style="gap:8px"><button class="btn clickable" data-go="home">跳过，先只用本机</button>' +
      '<div class="grow"></div>' + btn("下一步", { cls: "primary", go: "home", icon: "right" }) + "</div>" +
      '<div class="tiny muted">这一屏只在还没有可用对话模型时出现。之后这些页都还在设置里，' +
      "只是不再挡在第一句话前面。</div></div></div>"
    );
  };

  /* 手机 ---------------------------------------------------------------- */

  S["p-home"] = function () {
    return phone({
      screen: "p-home",
      head: phoneHead(
        '<span class="mark">' + icon("spark", 12) + "</span>",
        '<span class="strong">会话</span><span class="tiny muted">两件在生成</span>',
        '<button class="btn sm">' + icon("search", 16) + "</button>" +
          '<button class="btn sm clickable" data-go="p-new">' + icon("plus", 17) + "</button>"
      ),
      body:
        '<div class="scroll" style="padding:4px 14px 14px">' +
        '<div class="card row clickable" style="gap:10px;margin-bottom:10px" data-go="p-session">' +
        ph("", 292, "width:56px;height:56px;flex:none") +
        '<div class="grow col tight" style="gap:2px">' +
        '<div class="row" style="gap:6px">' + tag("故事", "posture") + '<span class="tiny muted">12 分钟前</span></div>' +
        '<span class="small strong truncate">雨夜巷口 · 第三幕</span>' +
        '<span class="tiny muted truncate">「她把伞收起来的时候，灯牌刚好闪了一下。」</span></div>' +
        icon("right", 16) + "</div>" +
        jobCard("Seedance · 图生视频", "约 2 分钟", 62, { go: "p-works" }) +
        '<div style="height:10px"></div>' +
        '<div class="card tight row clickable" style="gap:8px;border-color:' +
        'color-mix(in oklab,var(--warning) 45%,transparent)" data-go="p-home">' + icon("alert", 15) +
        '<span class="grow small">「三份周报」在等你批准</span>' + icon("right", 15) + "</div>" +
        '<div class="row wrap" style="gap:6px;padding:12px 0 6px">' +
        pill("做事", { icon: "wrench", go: "p-new" }) + pill("创作", { icon: "images", go: "p-new" }) +
        pill("角色", { icon: "user", go: "p-new" }) + pill("故事", { icon: "book", go: "p-new" }) + "</div>" +
        '<div class="tiny muted" style="padding:6px 2px">今天</div>' +
        CONVS.slice(0, 4).map(function (c) {
          return (
            '<div class="row clickable" style="gap:10px;padding:9px 0;border-bottom:1px solid var(--border)" ' +
            'data-go="p-session">' +
            (c.hue ? ph("", c.hue, "width:40px;height:40px;flex:none")
              : '<div class="cover blank" style="width:40px;height:40px;border-radius:9px">' + icon("chat", 15) + "</div>") +
            '<div class="grow col tight" style="gap:1px"><span class="small truncate">' + c.title + "</span>" +
            '<span class="tiny muted">' + c.posture + (c.ephemeral ? " · 临时" : "") +
            (c.pending ? " · 待批 1" : "") + (c.live ? " · 生成中" : "") + "</span></div>" +
            (c.live ? '<span class="dot"></span>' : "") + "</div>"
          );
        }).join("") + "</div>",
    });
  };

  S["p-new"] = function () {
    var rows = [
      ["wrench", "做事", "搜、读文件、改东西、记下来"],
      ["images", "创作", "边聊边出图、改图、让它动"],
      ["user", "角色", "入戏。可以用完就扔"],
      ["book", "故事", "连续的图文，人物不跑形"],
    ];
    return phone({
      screen: "p-new",
      head: phoneHead(
        '<span class="mark">' + icon("spark", 12) + "</span>",
        '<span class="strong">会话</span>',
        '<button class="btn sm">' + icon("search", 16) + "</button>"
      ),
      body: '<div class="scroll" style="padding:4px 14px;opacity:.35">' +
        '<div class="card" style="height:76px"></div><div style="height:10px"></div>' +
        '<div class="card" style="height:52px"></div></div>',
      sheet:
        '<div class="grabber"></div>' +
        '<div class="row between" style="padding:0 4px 6px"><span class="strong">开一个会话</span>' +
        '<button class="btn sm clickable" data-go="p-home">' + icon("x", 16) + "</button></div>" +
        '<div class="sheetrow clickable" data-go="p-session"><span class="glyph">' + icon("chat", 17) + "</span>" +
        '<div class="grow col tight" style="gap:0"><span>对话</span>' +
        '<span class="tiny muted">默认。直接说</span></div>' + icon("right", 15) + "</div>" +
        rows.map(function (r) {
          return (
            '<div class="sheetrow clickable" data-go="p-session"><span class="glyph">' + icon(r[0], 17) + "</span>" +
            '<div class="grow col tight" style="gap:0"><span>' + r[1] + "</span>" +
            '<span class="tiny muted">' + r[2] + "</span></div>" + icon("right", 15) + "</div>"
          );
        }).join("") +
        '<div class="row between" style="padding:12px 4px 4px"><span class="small">这次用完就扔</span>' +
        '<div class="switch on"><span></span></div></div>' +
        '<div class="tiny muted" style="padding:0 4px">临时会话在列表里标「临时」，结束时一键丢掉，不脏列表。</div>',
    });
  };

  function pSessionBody() {
    return (
      '<div class="scroll" style="padding:6px 14px 10px">' +
      '<div class="col" style="gap:12px">' +
      '<div class="user">一个雨夜的便利店门口，霓虹，胶片颗粒</div>' +
      toolBlock("generate_image", "rainy convenience store…", "done") +
      '<div class="row" style="gap:6px">' +
      ph("v1", 250, "flex:1;aspect-ratio:3/4", "p-sheet") +
      ph("v2", 32, "flex:1;aspect-ratio:3/4", "p-sheet") +
      "</div>" +
      '<div class="assistant small"><p>两版都带了参考板里的胶片颗粒。' +
      "长按任意一张可以改、可以让它动。</p></div>" +
      '<div class="user">第二张，灯牌换成中文</div>' +
      toolBlock("edit_image", "源：v2 · 参考 ×2", "done") +
      ph("v2b · 中文灯牌", 32, "aspect-ratio:3/4", "p-sheet") +
      "</div></div>"
    );
  }

  function pComposer(shortcuts) {
    return (
      '<div style="flex:none;padding:8px 12px 10px;border-top:1px solid var(--border)">' +
      '<div class="row" style="gap:6px;padding-bottom:8px;overflow:auto">' + shortcuts + "</div>" +
      '<div class="row" style="gap:8px"><button class="btn sm">' + icon("clip", 17) + "</button>" +
      '<div class="field grow">说点什么…</div>' +
      '<button class="btn sm primary" style="border-radius:999px;padding:7px">' + icon("send", 16) + "</button></div></div>"
    );
  }

  S["p-session"] = function () {
    return phone({
      screen: "p-session",
      tabs: false,
      head: phoneHead(
        '<button class="btn sm clickable" data-go="p-home">' + icon("back", 17) + "</button>",
        '<span class="row" style="gap:6px">' + tag("创作", "posture") +
          '<span class="small strong truncate">便利店霓虹</span></span>' +
          '<span class="tiny muted">Seedream 4 · 队列 1</span>',
        '<button class="btn sm clickable" data-go="p-params">' + icon("sliders", 17) + "</button>"
      ),
      body: pSessionBody() + pComposer(
        pill("出图", { icon: "images", go: "p-params" }) + pill("改图", { icon: "sliders", go: "p-params" }) +
        pill("让它动", { icon: "film", go: "p-params" }) + pill("参考 3", { icon: "pin" })
      ),
    });
  };

  S["p-sheet"] = function () {
    var rows = [
      ["images", "改这张", "以它为源再画一版"],
      ["film", "让它动", "5 秒 · 图生视频"],
      ["pin", "放到参考", "之后每次生成都带上"],
      ["down", "存到系统相册", ""],
      ["right", "看血缘", "模型、参数、父图"],
    ];
    return phone({
      screen: "p-sheet",
      tabs: false,
      head: phoneHead(
        '<button class="btn sm clickable" data-go="p-home">' + icon("back", 17) + "</button>",
        '<span class="row" style="gap:6px">' + tag("创作", "posture") +
          '<span class="small strong truncate">便利店霓虹</span></span>',
        '<button class="btn sm">' + icon("sliders", 17) + "</button>"
      ),
      body: pSessionBody(),
      sheet:
        '<div class="grabber"></div>' +
        '<div class="row" style="gap:10px;padding:0 4px 8px">' + ph("", 32, "width:44px;height:58px;flex:none") +
        '<div class="grow col tight" style="gap:1px"><span class="small strong">v2b · 中文灯牌</span>' +
        '<span class="tiny muted">Seedream 4 · 1024×1365 · 今天 14:22</span></div>' +
        '<button class="btn sm clickable" data-go="p-session">' + icon("x", 16) + "</button></div>" +
        rows.map(function (r) {
          return (
            '<div class="sheetrow clickable" data-go="' + (r[0] === "film" ? "p-params" : "p-session") + '">' +
            '<span class="glyph">' + icon(r[0], 17) + "</span>" +
            '<div class="grow col tight" style="gap:0"><span>' + r[1] + "</span>" +
            (r[2] ? '<span class="tiny muted">' + r[2] + "</span>" : "") + "</div>" + icon("right", 15) + "</div>"
          );
        }).join(""),
    });
  };

  S["p-params"] = function () {
    return phone({
      screen: "p-params",
      tabs: false,
      head: phoneHead(
        '<button class="btn sm clickable" data-go="p-session">' + icon("back", 17) + "</button>",
        '<span class="row" style="gap:6px">' + tag("创作", "posture") +
          '<span class="small strong truncate">便利店霓虹</span></span>',
        '<button class="btn sm">' + icon("sliders", 17) + "</button>"
      ),
      body: pSessionBody(),
      sheet:
        '<div class="grabber"></div>' +
        '<div class="segment" style="width:100%;margin-bottom:10px">' +
        '<button style="flex:1">生成图片</button><button style="flex:1">编辑图片</button>' +
        '<button aria-pressed="true" style="flex:1">视频</button></div>' +
        '<div class="row" style="gap:10px;padding:0 2px 10px">' + ph("", 32, "width:44px;height:58px;flex:none") +
        '<div class="grow col tight" style="gap:2px"><span class="small">源：v2b · 中文灯牌</span>' +
        '<span class="tiny muted">图生视频。视频当不了源，所以这里只能选图。</span></div></div>' +
        '<div class="capsules" style="padding:0 0 10px">' +
        pill("时长 5 秒", { cls: "on" }) + pill("镜头 缓慢推近", { cls: "on" }) + pill("画面 16:9") +
        pill("模型 Seedance 2.5") + pill("种子 随机") + "</div>" +
        '<div class="field" style="height:60px;margin-bottom:10px">雨滴落在灯牌上，光轻微晃动，镜头缓慢推近</div>' +
        btn("开始生成 · 约 2 分钟", { cls: "primary block", icon: "spark", go: "p-works" }) +
        '<div class="tiny muted" style="padding-top:8px">胶囊是 iOS 上已经有的设计，比桌面表单更适合拇指。' +
        "跑起来之后可以直接退出，好了会通知你。</div>",
    });
  };

  S["p-works"] = function () {
    var hues = [292, 32, 340, 250, 26, 210, 150, 300, 20, 268, 60, 12];
    return phone({
      screen: "p-works",
      head: phoneHead(
        "",
        '<span class="strong">作品</span><span class="tiny muted">248 件</span>',
        '<button class="btn sm">' + icon("search", 16) + "</button>" +
          '<button class="btn sm">' + icon("plus", 17) + "</button>"
      ),
      body:
        '<div class="capsules">' + pill("全部", { cls: "on" }) + pill("图") + pill("视频") +
        pill("我的参考") + pill("这段会话") + "</div>" +
        '<div class="scroll" style="padding:4px 12px 12px">' +
        '<div style="padding-bottom:10px">' + jobCard("Seedance · 图生视频", "约 2 分钟", 62) + "</div>" +
        '<div class="grid tight" style="grid-template-columns:repeat(3,1fr)">' +
        vid("", 292, "5s", "aspect-ratio:1;grid-column:span 2;grid-row:span 2", "p-sheet") +
        hues.slice(1).map(function (hu, i) {
          return i === 4
            ? vid("", hu, "4s", "aspect-ratio:1", "p-sheet")
            : ph("", hu, "aspect-ratio:1", "p-sheet");
        }).join("") + "</div>" +
        '<div class="tiny muted" style="padding-top:10px">点一张图就是那张 sheet：改 / 动 / 参考 / 相册 / 血缘。</div>' +
        "</div>",
    });
  };

  S["p-mine"] = function () {
    function row(glyph, label, sub, right, go) {
      return (
        '<div class="listrow' + (go ? " clickable" : "") + '"' + (go ? ' data-go="' + go + '"' : "") + ">" +
        '<span style="width:22px">' + icon(glyph, 17) + "</span>" +
        '<div class="grow col tight" style="gap:0"><span class="small">' + label + "</span>" +
        (sub ? '<span class="tiny muted">' + sub + "</span>" : "") + "</div>" +
        (right || "") + icon("right", 15) + "</div>"
      );
    }
    return phone({
      screen: "p-mine",
      head: phoneHead("", '<span class="strong">我的</span>', ""),
      body:
        '<div class="scroll">' +
        '<div class="card tight row" style="gap:10px;margin:6px 14px 12px">' +
        '<span class="dot ok"></span><div class="grow col tight" style="gap:0">' +
        '<span class="small strong">家里那台</span>' +
        '<span class="tiny muted">192.168.1.20:8090 · 通过 Tailscale · 队列 2 件</span></div>' +
        '<span class="tag warn">1 个后端红了</span></div>' +
        row("spark", "记忆", "7 条 · 412 / 2000 token", "") +
        row("folder", "文档", "23 份 · 1.2 GB", "") +
        row("pin", "参考板", "4 个集合 · 31 张", "", "p-works") +
        row("user", "角色卡", "3 张", "") +
        '<div class="tiny muted" style="padding:16px 14px 6px">设置</div>' +
        row("plug", "提供方与模型", "Ark · Venice · 本机 ComfyUI", "") +
        row("images", "图与视频后端", "改图绑在没启动的 ComfyUI 上", '<span class="dot bad"></span>') +
        row("wrench", "能力", "搜索、检索、编码、MCP", "") +
        row("book", "提示词与姿势", "全局 + 四层", "") +
        row("shield", "安全", "访问码 · 两步验证已开 · 3 台设备", "") +
        row("sliders", "外观", "跟随系统", "") +
        '<div class="tiny muted" style="padding:14px">data/ 共 46.8 GB。没有云端备份——这台机器就是全部。</div>' +
        "</div>",
    });
  };

  /* --------------------------------------------------------------- notes */

  var SCREENS = [
    { g: "会话", id: "home", name: "首页", where: "桌面 · 打开产品第一眼", view: S.home, notes: [
      "打开看到的是<b>上一段委托</b>，不是一个空输入框。这条对应验收里的第 1 问。",
      "四张姿势卡就是「按什么姿势开」。用户永远看不到「姿势」这个词。",
      "进行中的生成和待批在首页有位置——人会离开那段会话去干别的。",
      "左栏三格：会话 / 作品 / 我的。文件和记忆不再各占一栏。",
    ] },
    { g: "会话", id: "chat", name: "对话", where: "桌面 · 默认姿势", view: S.chat, notes: [
      "空状态一句「直接说」。没有功能清单。",
      "模型顺手画的图<b>就是作品</b>：同一组动作（改 / 动 / 参考 / 血缘）挂在图上，" +
        "不需要先切到另一个栏目。",
      "工具调用仍是可展开的块——看得见 agent 做了什么，但不做成 IDE 的时间线。",
    ] },
    { g: "会话", id: "do", name: "做事", where: "桌面 · 用法 1", view: S.do, notes: [
      "侧栏是「<b>这一段在用的</b>」：附过的文件、检索命中、待批、工作目录。",
      "审批仍是转写里的卡片而不是模态；首页那条待批是给已经离开的人看的。",
      "run 在跑时作曲栏不变灰，而是「插一句，这轮完了算进去」——" +
        "<code>POST /conversations/:id/steer</code> 已经在 /v1 上，两个前端都还没接。",
    ] },
    { g: "会话", id: "create", name: "创作", where: "桌面 · 用法 2", view: S.create, notes: [
      "出图不用离开会话（验收第 2 问）。作曲栏上的出图 / 改图 / 让它动就是全部入口。",
      "侧栏参考板里钉住的图，会自动作为 <code>additional_source_image_ids</code> 带进每次生成。",
      "进行中的 job 就在旁边，按分钟说话，不按百分比空转。",
      "底部提前说明本机 ComfyUI 没在监听——不是等提交完再报错（验收第 8 问）。",
    ] },
    { g: "会话", id: "inspector", name: "检查器", where: "桌面 · 创作 + 精确参数", view: S.inspector, notes: [
      "今天的创作台表单原样保留，只是从一个栏目变成一个抽屉。",
      "<code>GET /studio/tools</code> 的 schema 不动；<code>/studio</code> 路由留作深链。",
      "参考那一行说明了钉住的图会被带上，人可以临时取消某一张。",
    ] },
    { g: "会话", id: "role", name: "角色", where: "桌面 · 用法 3", view: S.role, notes: [
      "顶栏的「临时」标 + 「结束并丢弃」：一次性 roleplay 不该弄脏列表（验收第 4 问）。",
      "侧栏是一张卡，不是酒馆那种五十个折叠面板。脸同时就是这段会话的身份锚。",
      "支持导入社区的 V2 / V3 PNG 角色卡——这是别人攒了很多年的内容，一个解析器就能接上。" +
        "但不做卡市场、不做群聊、不做表情差分。",
    ] },
    { g: "会话", id: "story", name: "故事", where: "桌面 · 用法 4", view: S.story, notes: [
      "侧栏「连续性」是这段会话的记忆：人物（一句外貌 + 锁定的参考图）、地点、画风、已发生。",
      "<b>身份锚每次重新注入</b>：参考图进源图，外貌那句追加到提示词尾部。" +
        "2026 年那批图文书工具和 S2ED / CharCom 这些论文得到的是同一个结论——" +
        "角色漂移是默认行为，只能靠显式状态传递解决（验收第 5 问）。",
      "「已发生」允许模型草拟、人一键确认，绝不静默写入。",
      "作曲栏三个捷径：续写 / 画这一幕 / 让这张动。这就是「连续图文」和「人来回拷提示词」的区别。",
    ] },
    { g: "作品", id: "works", name: "作品", where: "桌面 · 图与视频同一格", view: S.works, notes: [
      "图和视频同一种磁贴（后端本来就是同一个 <code>GeneratedAsset</code>）。",
      "进行中的 job 钉在顶上，锁屏回来还在（验收第 7 问）。",
      "上传就是「加入参考」，不用先去文件栏。文档不混进来，它们在「我的 / 文档」。",
    ] },
    { g: "作品", id: "asset", name: "作品详情", where: "桌面 · 作品上的动作", view: S.asset, notes: [
      "四个动作：改这张 / 让它动 / 放到参考 / 存到相册。<b>「让它动」是视频的主路</b>（验收第 3 问）。",
      "血缘指回父图和出处会话，一步能跳回去。",
      "视频磁贴上不会出现「以此为源」——父本只有 <code>img_</code>，界面不该假装有这条路。",
    ] },
    { g: "作品", id: "refs", name: "参考板", where: "桌面 · 用法 5", view: S.refs, notes: [
      "「上传我喜欢的作品当参考」不是一张匿名图：它有用途（画风 / 人物 / 场景 / 光）和一句锚定文本。",
      "人物条目上的那句话就是注入 prompt 的那句。这一屏解释了整个机制（验收第 6 问）。",
      "钉到会话之后，创作和故事的生成默认带上，不用每轮重附。",
    ] },
    { g: "我的与设置", id: "mine", name: "我的", where: "桌面 · 记忆 / 文档 / 连接 / 数据", view: S.mine, notes: [
      "记忆和文件从常驻栏收进这里——它们是会话的给养，不是每天要去报到的地方。",
      "「连接」回答的是：连的是家里哪台、队列里还有没有活、哪个后端红了。",
      "数据那一段把话说清楚：没有云端备份，删掉 data/ 等于出厂。",
    ] },
    { g: "我的与设置", id: "settings", name: "设置 · 生成", where: "桌面 · 五组分类", view: S.settings, notes: [
      "六页的能力一个不少，只改分组：连接 / 生成 / 能力 / 人格 / 系统。",
      "三个槽（生图 / 改图 / 视频）决定对话里那三个工具走谁，也决定检查器默认选中谁。",
      "ComfyUI 工作流绑定继续只在网页改：PATCH 是合并语义，" +
        "iOS 上渲染一半字段的表单一保存就会抹掉另一半。",
    ] },
    { g: "我的与设置", id: "health", name: "后端健康", where: "桌面 · 新增的一页", view: S.health, notes: [
      "这一页是新的。今天这些状态只在生成失败的那一刻才说话，而那时人已经等过一次了。",
      "失败要指向下一步：换成托管的 / 怎么启动 / 重测，而不是只留一句 fetch failed。",
      "Luma 不会因为绑定的后端挂了就悄悄换一个——换了，拿到的就不是自己要的画风。",
    ] },
    { g: "我的与设置", id: "first", name: "第一次配置", where: "桌面 · 只出现一次", view: S.first, notes: [
      "只在还没有可用对话模型时出现，三步结束（验收第 9 问）。",
      "勾上的模型直接成为对话 / 生图 / 视频三个默认槽，不用再进三个页面各设一次。",
      "只用本机 ComfyUI 的人可以整步跳过。",
    ] },
    { g: "手机", id: "p-home", name: "会话", where: "iPhone · 底栏三格", view: S["p-home"], notes: [
      "底栏三格：会话 / 作品 / 我的。不是桌面五栏的缩略。",
      "打开就是上一段，进行中和待批各占一条，姿势是四个胶囊。",
      "目标手感对标 Locally——但它后面站着的是一台能出图、会做事的机器，不是一个推理进程。",
    ] },
    { g: "手机", id: "p-new", name: "开一个会话", where: "iPhone · sheet", view: S["p-new"], notes: [
      "新会话是一张 sheet，不是一个新页面。默认「对话」排在最上面，一点就进。",
      "「这次用完就扔」是开会话时的一个开关，不是事后清理。",
    ] },
    { g: "手机", id: "p-session", name: "会话 · 创作", where: "iPhone · 转写全屏", view: S["p-session"], notes: [
      "进入会话后底栏让位，转写全屏。会话地址仍写在路由里，后台被杀还能回来。",
      "作曲栏上一排捷径胶囊：出图 / 改图 / 让它动 / 参考 3。",
      "顶栏说明当前的生成模型和队列——手机上这两件事最容易失联。",
    ] },
    { g: "手机", id: "p-sheet", name: "一张图的动作", where: "iPhone · sheet", view: S["p-sheet"], notes: [
      "一张图上的动作必须是 sheet，不能把桌面的左右分栏塞进来（验收第 10 问）。",
      "五个动作和桌面完全一致：同一张图在两块屏幕上不该有两套菜单。",
    ] },
    { g: "手机", id: "p-params", name: "参数与队列", where: "iPhone · 胶囊检查器", view: S["p-params"], notes: [
      "胶囊是 iOS 今天已经有的设计，比桌面表单更适合拇指，值得保留并反向影响桌面。",
      "按钮上直接写「约 2 分钟」。跑起来就可以退出，好了会通知。",
      "诚实的短板：iOS 离屏几秒就被挂起，十分钟后完成的 job 发不出本地通知。" +
        "自托管不该为此引入 APNs——靠 <code>BGAppRefreshTask</code> 机会性查一次，" +
        "以及回到前台时队列立刻在眼前。",
    ] },
    { g: "手机", id: "p-works", name: "作品", where: "iPhone · 网格", view: S["p-works"], notes: [
      "和桌面同一份筛选、同一种磁贴、同一个置顶队列。",
      "视频直接在格子里播，不跳出去。",
    ] },
    { g: "手机", id: "p-mine", name: "我的", where: "iPhone · 设置入口", view: S["p-mine"], notes: [
      "顶部先回答「我连的是哪台、队列多少、有没有后端红了」。",
      "提供方、对话模型、安全都能在 App 里改；生成模型的 params 仍只在网页改。",
    ] },
  ];

  /* ------------------------------------------------------------- runtime */

  var indexEl = document.getElementById("index");
  var stageHead = document.getElementById("stagehead");
  var scaler = document.getElementById("scaler");
  var notesEl = document.getElementById("notes");
  var current = SCREENS[0].id;

  function buildIndex() {
    var html = "";
    var group = "";
    SCREENS.forEach(function (s) {
      if (s.g !== group) {
        group = s.g;
        html += "<h3>" + group + "</h3>";
      }
      html +=
        '<button data-screen="' + s.id + '"' + (s.id === current ? ' aria-current="true"' : "") +
        "><i>" + (s.id.indexOf("p-") === 0 ? "▯" : "▭") + "</i>" + s.name + "</button>";
    });
    indexEl.innerHTML = html;
  }

  function fit() {
    var frame = scaler.firstElementChild;
    if (!frame) return;
    var isPhone = frame.classList.contains("phone");
    var w = isPhone ? 390 : 1280;
    var height = isPhone ? 844 : 800;
    var avail = scaler.clientWidth;
    var scale = Math.min(1, avail / w);
    var offset = Math.max(0, (avail - w * scale) / 2);
    frame.style.transform = "translateX(" + offset + "px) scale(" + scale + ")";
    scaler.style.height = height * scale + "px";
  }

  function render() {
    var s = SCREENS.filter(function (x) { return x.id === current; })[0] || SCREENS[0];
    stageHead.innerHTML = "<h2>" + s.name + '</h2><span class="where">' + s.where + "</span>";
    scaler.innerHTML = s.view();
    notesEl.innerHTML =
      "<h4>这一屏在解决什么</h4><ul>" +
      s.notes.map(function (n) { return "<li>" + n + "</li>"; }).join("") + "</ul>";
    Array.prototype.forEach.call(indexEl.children, function (el) {
      if (el.tagName === "BUTTON") {
        if (el.getAttribute("data-screen") === current) el.setAttribute("aria-current", "true");
        else el.removeAttribute("aria-current");
      }
    });
    fit();
  }

  function go(id) {
    if (!SCREENS.some(function (s) { return s.id === id; })) return;
    current = id;
    window.location.hash = id;
    render();
  }

  document.addEventListener("click", function (event) {
    var pick = event.target.closest ? event.target.closest("[data-screen]") : null;
    if (pick) {
      go(pick.getAttribute("data-screen"));
      return;
    }
    var hop = event.target.closest ? event.target.closest("[data-go]") : null;
    if (hop) go(hop.getAttribute("data-go"));
  });

  var themeEl = document.getElementById("theme");
  themeEl.addEventListener("click", function (event) {
    var hit = event.target.closest("[data-theme]");
    if (!hit) return;
    var dark = hit.getAttribute("data-theme") === "dark";
    document.documentElement.classList.toggle("dark", dark);
    Array.prototype.forEach.call(themeEl.querySelectorAll("[data-theme]"), function (b) {
      b.setAttribute("aria-pressed", String(b === hit));
    });
  });

  window.addEventListener("resize", fit);
  window.addEventListener("hashchange", function () {
    var id = window.location.hash.slice(1);
    if (id && id !== current) go(id);
  });

  buildIndex();
  var initial = window.location.hash.slice(1);
  if (initial && SCREENS.some(function (s) { return s.id === initial; })) current = initial;
  render();
})();
