/* dsh-bit-office — browser client bundle（源码模板，构建后产出 lib/client.js）
 *
 * 形态：官方 client bundle —— `window.__ModuleLoader__.load({id, factory})`，
 * factory 返回 `{name, inject, apply}`，由 client 内核挂载时调用 `apply(ctx)`。
 *
 * UI 形态：会话标题栏的一个 tab「办公室」（官方 `conversation.view` list 槽，
 * 与 对话/轨迹 同排）。**只有激活该 tab 时才渲染**，所以轮询/请求都写在组件里，
 * 切走即卸载（清理写在 useEffect 返回值里）；页面不可见（document.hidden）时暂停轮询。
 *
 * 数据来源：Node half 的同源只读路由 `GET /api/dsh-bit-office/state?session=<id>`
 * ——与网页同一份数据（agents/rooms/zones），当前会话用 `highlightId` 高亮，
 * 父子/委托关系用虚线连线。
 *
 * 渲染器 `renderFloorplan` 是**无依赖纯函数**（src/floorplan.mjs）：构建脚本
 * 把它内联进本文件，Node 侧单测直接 import 同一个模块——同一份代码两处使用。
 *
 * 注意：factory 里的 require 只能解析种子模块（react 等），不要 require 本包
 * 的其它文件（会 404）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bit-office',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const el = react.createElement;

    /* ------------------------------------------------------------------
     * 内联：src/floorplan.mjs（构建脚本注入，勿手改本段）
     * ---------------------------------------------------------------- */
    /* __FLOORPLAN_INLINE__ */
    /* ---------------------- 内联结束 ---------------------------------- */

    const POLL_MS = 10000;

    /* 与官方 token 同色系；平面图内部样式全部走 SVG attribute，不受宿主 CSS 影响。 */
    const S = {
      root: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '14px 16px 0' },
      bar: { display: 'flex', alignItems: 'center', gap: '10px', padding: '0 2px 10px', flexWrap: 'wrap' },
      title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-text-primary, #e6e8ee)' },
      stat: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #9aa3b2)' },
      badge: (tone) => ({
        fontSize: '11px', padding: '2px 7px', borderRadius: '999px',
        border: '1px solid ' + (tone === 'warn' ? '#a3743f' : tone === 'err' ? '#a4554f' : '#4a5361'),
        color: tone === 'warn' ? '#e5b497' : tone === 'err' ? '#e79b93' : '#9aa3b2',
      }),
      grow: { flex: 1 },
      btn: {
        font: 'inherit', fontSize: '12px', padding: '4px 10px', borderRadius: '6px',
        border: '1px solid #4a5361', background: 'transparent',
        color: 'var(--dsw-alias-text-primary, #e6e8ee)', cursor: 'pointer',
      },
      canvas: { flex: 1, minHeight: 0, overflow: 'auto', borderRadius: '10px', background: '#171c21' },
      empty: { padding: '28px 16px', fontSize: '13px', color: '#9aa3b2' },
      legend: {
        display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center',
        fontSize: '11px', color: '#8b93a1',
        padding: '10px 2px calc(var(--dsh-composer-height, 152px) + 10px)',
      },
      dot: (color) => ({ display: 'inline-block', width: '9px', height: '9px', borderRadius: '2px', background: color, marginRight: '5px' }),
    };

    function OfficeView(props) {
      const sessionId = (props && props.sessionId) || '';
      const [snap, setSnap] = react.useState(null);
      const [error, setError] = react.useState('');
      const [loading, setLoading] = react.useState(false);
      const inflight = react.useRef(false);

      const load = react.useCallback(async () => {
        if (inflight.current) return;
        inflight.current = true;
        setLoading(true);
        try {
          const url = '/api/dsh-bit-office/state' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : '');
          const res = await fetch(url, { headers: { accept: 'application/json' } });
          const body = await res.json();
          setSnap(body);
          setError(body && body.error ? String(body.error) : '');
        } catch (err) {
          setError(err && err.message ? String(err.message) : String(err));
        } finally {
          inflight.current = false;
          setLoading(false);
        }
      }, [sessionId]);

      react.useEffect(() => {
        let alive = true;
        const tick = () => {
          // 页面不可见时暂停轮询（切回来立刻补一次）
          if (typeof document !== 'undefined' && document.hidden) return;
          if (alive) void load();
        };
        tick();
        const timer = window.setInterval(tick, POLL_MS);
        const onVisibility = () => {
          if (typeof document !== 'undefined' && !document.hidden) tick();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          alive = false;
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [load]);

      const office = snap && snap.office ? snap.office : null;
      const model = layoutFloorplan(office, { highlightId: sessionId });
      const svg = error && !office ? '' : renderFloorplan(office, { highlightId: sessionId, idPrefix: 'bo-view' });
      const current = model.pets.find((p) => p.highlight);
      const note = emptyStateNote(model);

      const badges = [];
      if (snap && snap.stale) {
        badges.push(el('span', { key: 'stale', style: S.badge('warn'), title: snap.error || '' }, '远端读取失败 · 显示本地账本'));
      }
      if (snap && snap.cached) badges.push(el('span', { key: 'cached', style: S.badge(''), title: '本地缓存（5s）' }, '缓存'));
      if (current) {
        badges.push(el('span', { key: 'me', style: S.badge(''), title: current.id },
          '本会话：' + current.activityLabel + ' · ' + current.roomId));
      }

      return el('div', { style: S.root }, [
        el('div', { key: 'bar', style: S.bar }, [
          el('span', { key: 't', style: S.title }, '办公室'),
          el('span', { key: 's', style: S.stat },
            model.stats.agents
              ? `${model.stats.active} 在位 · ${model.stats.rooms} 房间 · ${model.stats.zones} 分区 · 已退休 ${model.stats.retired}`
              : '暂无登记'),
          ...badges,
          el('span', { key: 'g', style: S.grow }),
          el('span', { key: 'poll', style: S.stat }, loading ? '刷新中…' : `每 ${POLL_MS / 1000}s 自动刷新`),
          el('button', { key: 'r', type: 'button', style: S.btn, onClick: () => { void load(); } }, '立即刷新'),
        ]),
        el('div', {
          key: 'c',
          style: S.canvas,
          // SVG 由纯函数生成，所有文本都已 XML 转义
          ...(svg ? { dangerouslySetInnerHTML: { __html: svg } } : {}),
        }, svg ? null : [
          el('div', { key: 'e', style: S.empty },
            error
              ? `读取办公室状态失败：${error}`
              : note || '正在读取办公室状态…'),
        ]),
        el('div', { key: 'l', style: S.legend }, [
          el('span', { key: 'a' }, [el('i', { key: 'd', style: S.dot('#c5b3ee') }), '当前会话']),
          el('span', { key: 'b' }, '虚线 = 委托/父子关系'),
          el('span', { key: 'c' }, '▶ 运行中任务'),
          el('span', { key: 'd' }, '! 任务被阻塞'),
          el('span', { key: 'e' }, 'z = 离线/已退休'),
        ]),
      ]);
    }

    const CSS = [
      '.bo-floorplan{display:block;width:100%;height:auto}',
      '.bo-pet{transition:transform .2s ease}',
      '.bo-room rect{transition:stroke .15s ease}',
    ].join('');

    exports.name = 'dsh-bit-office';
    exports.inject = ['slots'];

    exports.apply = (ctx) => {
      /* 样式：自带 <style> 节点，卸载时移除（不依赖宿主 styles 服务）。 */
      const styleEl = document.createElement('style');
      styleEl.setAttribute('data-dsh-bit-office', '');
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);

      /* 注册会话标题栏 tab：官方 conversation.view 是 list 槽，只有 tab 数 > 1
       * 时才渲染 tab 条（对话/轨迹 已占两位，所以本 tab 会出现）。
       * label 用函数形式（官方 chat/trajectory 同款），避免裸字符串被当 locale key。 */
      let disposeEntry = null;
      const registerTab = () => {
        if (disposeEntry) {
          try { disposeEntry(); } catch { /* 已释放 */ }
          disposeEntry = null;
        }
        disposeEntry = ctx.slots.register({
          name: 'conversation.view',
          id: 'office',
          order: 25,
          label: () => '办公室',
        }, OfficeView);
      };
      // 槽声明可能后到（加载顺序 / fiber 热换）→ 用 inject 等它
      const disposeInject = ctx.slots.inject('conversation.view', registerTab);

      return () => {
        try { disposeInject(); } catch { /* noop */ }
        try { if (disposeEntry) disposeEntry(); } catch { /* noop */ }
        try { styleEl.remove(); } catch { /* noop */ }
      };
    };

    return module.exports;
  },
});
