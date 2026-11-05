window.__ModuleLoader__.load({
  id: "dsh-island-overlay",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let React = require("react");
    let P = require("@deepseek-ai/dsh-client-ui-primitives");
    let e = React.createElement;

    var NS = "dsh-island-overlay";
    var API = "/dsh-island/config.json";

    var ZH = {
      "panel.title": "灵动岛设置",
      "panel.hint": "改动即时生效，写入 ~/.dsh/dsh-island-config.json。",
      "size.title": "尺寸",
      "size.scale": "胶囊缩放",
      "size.mini": "迷你态直径",
      "pos.title": "位置",
      "pos.center": "顶部居中",
      "pos.right": "右上角",
      "pos.custom": "记住拖拽位置",
      "when.title": "显示时机",
      "when.always": "始终显示",
      "when.background": "仅在 DSH 不在前台时",
      "hold.title": "收起时间",
      "hold.hint": "状态停留多久后缩成小图标（毫秒）。审批与提问不会收起。",
      "hold.thinking": "思考",
      "hold.done": "完成",
      "hold.failed": "失败",
      "fx.title": "动效",
      "fx.whale": "小鲸鱼尾巴",
      "fx.pulse": "脉冲与涟漪",
      "fx.shake": "失败抖动",
      "fx.reduce": "减少动效",
      "states.title": "显示哪些状态",
      "states.thinking": "思考",
      "states.approval": "审批",
      "states.done": "完成",
      "states.failed": "失败",
      "misc.title": "其他",
      "misc.fullscreen": "全屏应用时自动隐藏",
      "state.loading": "读取中…",
      "state.saved": "已保存",
      "state.error": "保存失败",
      "button.reset": "恢复默认",
    };
    var EN = {
      "panel.title": "Dynamic island settings",
      "panel.hint": "Changes apply immediately and are written to ~/.dsh/dsh-island-config.json.",
      "size.title": "Size",
      "size.scale": "Capsule scale",
      "size.mini": "Mini size",
      "pos.title": "Position",
      "pos.center": "Top center",
      "pos.right": "Top right",
      "pos.custom": "Remember drag position",
      "when.title": "When to show",
      "when.always": "Always",
      "when.background": "Only when DSH is not focused",
      "hold.title": "Collapse delay",
      "hold.hint": "How long a state stays expanded before shrinking to the icon (ms). Approval and questions never collapse.",
      "hold.thinking": "Thinking",
      "hold.done": "Done",
      "hold.failed": "Failed",
      "fx.title": "Effects",
      "fx.whale": "Whale tail",
      "fx.pulse": "Pulse and ripple",
      "fx.shake": "Failure shake",
      "fx.reduce": "Reduce motion",
      "states.title": "States to show",
      "states.thinking": "Thinking",
      "states.approval": "Approval",
      "states.done": "Done",
      "states.failed": "Failed",
      "misc.title": "Other",
      "misc.fullscreen": "Hide over fullscreen apps",
      "state.loading": "Loading…",
      "state.saved": "Saved",
      "state.error": "Save failed",
      "button.reset": "Restore defaults",
    };

    // 默认中文；apply 时若有 locale 服务就换成它绑定的 t（跟随宿主语言）
    var t = function (key) {
      var s = ZH[key];
      return typeof s === "string" ? s : key;
    };

    // 只做布局，视觉交给 DSH 官方组件与 CSS 变量
    var L = {
      section: {
        display: "flex", flexDirection: "column", gap: "12px",
        paddingBottom: "16px", borderBottom: "1px solid var(--dsw-alias-border-l2)",
      },
      last: { display: "flex", flexDirection: "column", gap: "12px", paddingTop: "4px" },
      title: { fontSize: "13px", fontWeight: "600", color: "var(--dsw-alias-label-primary)", margin: 0 },
      hint: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", margin: 0, lineHeight: 1.5 },
      row: {
        display: "flex", alignItems: "center", gap: "12px", padding: "8px 10px",
        borderRadius: "var(--dsw-radius-sm, 6px)", backgroundColor: "var(--dsw-alias-bg-layer-1)",
      },
      rowText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: 1 },
      rowName: { fontSize: "13px", color: "var(--dsw-alias-label-primary)" },
      footer: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
      range: { width: "140px", accentColor: "var(--dsw-alias-brand-primary)" },
      num: {
        width: "88px", padding: "4px 8px", fontSize: "13px", textAlign: "right",
        color: "var(--dsw-alias-label-primary)", backgroundColor: "var(--dsw-alias-bg-layer-1)",
        border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-sm, 6px)",
      },
      val: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", minWidth: "38px", textAlign: "right" },
    };

    function get(path) {
      return fetch(API + path, { cache: "no-store", credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))) });
    }

    function post(patch) {
      return fetch(API, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: patch }),
      }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(String(r.status))) });
    }

    function Slider(props) {
      return e("div", { style: L.row },
        e("div", { style: L.rowText }, e("span", { style: L.rowName }, props.label)),
        e("input", {
          type: "range", min: props.min, max: props.max, step: props.step,
          value: props.value, disabled: props.disabled, style: L.range,
          onChange: function (ev) { props.onChange(Number(ev.target.value)); },
        }),
        e("span", { style: L.val }, props.display),
      );
    }

    function NumberRow(props) {
      return e("div", { style: L.row },
        e("div", { style: L.rowText }, e("span", { style: L.rowName }, props.label)),
        e("input", {
          type: "number", min: 0, max: 60000, step: 100,
          value: props.value, disabled: props.disabled, style: L.num,
          onChange: function (ev) {
            var n = Number(ev.target.value);
            props.onChange(Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 60000) : 0);
          },
        }),
      );
    }

    function SwitchRow(props) {
      return e("div", { style: L.row },
        e("div", { style: L.rowText }, e("span", { style: L.rowName }, props.label)),
        e(P.Switch, {
          checked: props.checked, disabled: props.disabled,
          label: props.label, onChange: props.onChange,
        }),
      );
    }

    function IslandConfigPanel() {
      var [cfg, setCfg] = React.useState(null);
      var [status, setStatus] = React.useState("loading");
      var [note, setNote] = React.useState(null);

      React.useEffect(function () {
        get("").then(function (res) { setCfg(res.cfg); setStatus("ready"); })
          .catch(function () { setStatus("error"); });
      }, []);

      // 每次改动都写一份完整 patch（嵌套对象整体替换，避免半截合并）
      var save = React.useCallback(function (next) {
        setCfg(next);
        setNote(null);
        post(next).then(function (res) { setCfg(res.cfg); setNote(t("state.saved")); })
          .catch(function () { setNote(t("state.error")); });
      }, []);

      if (status === "loading" || !cfg) return e("p", { style: L.hint }, t("state.loading"));
      if (status === "error") return e("p", { style: L.hint }, t("state.error"));

      var patch = function (key, value) {
        var next = JSON.parse(JSON.stringify(cfg));
        next[key] = value;
        save(next);
      };
      var patchSub = function (group, key, value) {
        var next = JSON.parse(JSON.stringify(cfg));
        next[group] = next[group] || {};
        next[group][key] = value;
        save(next);
      };

      var seg = function (id, label, value, options, onPick) {
        return e(P.SegmentedControl, {
          id: id, label: label, value: value, options: options, onChange: onPick,
        });
      };

      return e("div", { style: { display: "flex", flexDirection: "column", gap: "16px", maxWidth: "720px" } },
        e("h3", { style: { fontSize: "15px", fontWeight: "600", margin: 0, color: "var(--dsw-alias-label-primary)" } },
          t("panel.title")),
        e("p", { style: L.hint }, t("panel.hint")),

        e("div", { style: L.section },
          e("h4", { style: L.title }, t("size.title")),
          e(Slider, {
            label: t("size.scale"), min: 0.7, max: 1.6, step: 0.05, value: cfg.scale,
            display: Math.round(cfg.scale * 100) + "%",
            onChange: function (v) { patch("scale", v); },
          }),
          e(Slider, {
            label: t("size.mini"), min: 24, max: 64, step: 1, value: cfg.mini,
            display: cfg.mini + "px",
            onChange: function (v) { patch("mini", v); },
          })
        ),

        e("div", { style: L.section },
          e("h4", { style: L.title }, t("pos.title")),
          seg("island-pos", t("pos.title"), cfg.position, [
            { value: "top-center", label: t("pos.center") },
            { value: "top-right", label: t("pos.right") },
            { value: "custom", label: t("pos.custom") },
          ], function (v) { patch("position", v); }),
          e("h4", { style: L.title }, t("when.title")),
          seg("island-when", t("when.title"), cfg.showWhen, [
            { value: "always", label: t("when.always") },
            { value: "background", label: t("when.background") },
          ], function (v) { patch("showWhen", v); })
        ),

        e("div", { style: L.section },
          e("h4", { style: L.title }, t("hold.title")),
          e("p", { style: L.hint }, t("hold.hint")),
          e(NumberRow, { label: t("hold.thinking"), value: cfg.holdMs.thinking, onChange: function (v) { patchSub("holdMs", "thinking", v); } }),
          e(NumberRow, { label: t("hold.done"), value: cfg.holdMs.done, onChange: function (v) { patchSub("holdMs", "done", v); } }),
          e(NumberRow, { label: t("hold.failed"), value: cfg.holdMs.failed, onChange: function (v) { patchSub("holdMs", "failed", v); } })
        ),

        e("div", { style: L.section },
          e("h4", { style: L.title }, t("fx.title")),
          e(SwitchRow, { label: t("fx.whale"), checked: cfg.effects.whale, onChange: function (v) { patchSub("effects", "whale", v); } }),
          e(SwitchRow, { label: t("fx.pulse"), checked: cfg.effects.pulse, onChange: function (v) { patchSub("effects", "pulse", v); } }),
          e(SwitchRow, { label: t("fx.shake"), checked: cfg.effects.shake, onChange: function (v) { patchSub("effects", "shake", v); } }),
          e(SwitchRow, { label: t("fx.reduce"), checked: cfg.effects.reduce, onChange: function (v) { patchSub("effects", "reduce", v); } })
        ),

        e("div", { style: L.section },
          e("h4", { style: L.title }, t("states.title")),
          e(SwitchRow, { label: t("states.thinking"), checked: cfg.states.thinking, onChange: function (v) { patchSub("states", "thinking", v); } }),
          e(SwitchRow, { label: t("states.approval"), checked: cfg.states.approval, onChange: function (v) { patchSub("states", "approval", v); } }),
          e(SwitchRow, { label: t("states.done"), checked: cfg.states.done, onChange: function (v) { patchSub("states", "done", v); } }),
          e(SwitchRow, { label: t("states.failed"), checked: cfg.states.failed, onChange: function (v) { patchSub("states", "failed", v); } })
        ),

        e("div", { style: Object.assign({}, L.section, L.last, { borderBottom: "none" }) },
          e("h4", { style: L.title }, t("misc.title")),
          e(SwitchRow, { label: t("misc.fullscreen"), checked: cfg.hideFullscreen, onChange: function (v) { patch("hideFullscreen", v); } }),
          e("div", { style: L.footer },
            e("span", { style: L.hint }, note || t("state.saved")),
            e(P.Button, {
              variant: "outline", size: "sm",
              onClick: function () {
                get("/defaults").then(function (res) { save(res.cfg); }).catch(function () { setNote(t("state.error")); });
              },
            }, t("button.reset"))
          )
        )
      );
    }

    async function apply(ctx) {
      if (ctx.locale) {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: ZH, en: EN });
        }, "dsh-island: dictionaries");
        // 组件不接收 ctx（渲染器铁律），所以 t 走 factory 级变量
        try { t = ctx.locale.bind(NS); } catch (err) {}
      }
      ctx.effect(function () {
        return ctx.slots.inject("plugins.bundle.config", function () {
          return ctx.slots.register(
            { name: "plugins.bundle.config", key: "dsh-island-overlay", locale: NS },
            IslandConfigPanel
          );
        });
      }, "dsh-island: config card");
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});
